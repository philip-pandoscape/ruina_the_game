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
//! simulation takes it up (`sim::load_life`) and puts it away (`sim::life_save`). A region's
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
use ruina_world_api::store::{ClaimResult, LifeWrite, RegionLand, TakeResult, Then, ToStore, Transfer, Writer};
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

/// Whether a life's write is fenced by its writer's lease as well as by the character's epoch: so
/// once the leases are Postgres's (several processes share the world: crates/server/src/cluster),
/// not while one process keeps them in memory.
static FENCED_BY_LEASES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// From now on every life written is fenced by its writer's lease too (`space_leases`).
pub fn fence_by_leases() {
    FENCED_BY_LEASES.store(true, std::sync::atomic::Ordering::Relaxed);
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
                let row: Option<LifeRow> = sqlx::query_as("SELECT life, build, (extract(epoch FROM saved_at) * 1000)::bigint FROM characters WHERE id = $1")
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

    /// Lends a character's land to the life read for them now: it alone changes it until it's given
    /// back (land::pieces).
    pub async fn lend(&self, character: CharacterId) -> Result<(), String> {
        match self {
            Db::Pg(db) => land::pieces::lend(db, character).await.map_err(|e| e.to_string()),
            Db::Memory(t) => {
                Db::tables(t).lend(character);
                Ok(())
            }
        }
    }

    /// A character's land back from the life it was lent to, under the grant it played under.
    pub async fn give_back(&self, character: CharacterId, epoch: Epoch) -> Result<(), String> {
        match self {
            Db::Pg(db) => land::pieces::give_back(db, character, epoch.0 as i64).await.map_err(|e| e.to_string()),
            Db::Memory(t) => {
                Db::tables(t).give_back(character, epoch.0);
                Ok(())
            }
        }
    }

    /// A piece of `owner`'s land taken by `by` (under their grant `epoch`): the first to ask has it,
    /// and only while `owner`'s land isn't lent to their life.
    pub async fn take_piece(&self, piece: i64, owner: CharacterId, by: CharacterId, epoch: Epoch) -> Result<TakeResult, String> {
        let taken = match self {
            Db::Pg(db) => land::pieces::take(db, piece, owner, by, epoch.0 as i64).await.map_err(|e| e.to_string())?,
            Db::Memory(t) => Db::tables(t).take_piece(piece, owner, by, epoch.0),
        };
        Ok(match taken {
            land::pieces::Taken::Yours(rows) => TakeResult::Yours(rows.into_iter().map(|(k, d)| (k.name().to_string(), d)).collect()),
            land::pieces::Taken::Lent => TakeResult::Lent,
            land::pieces::Taken::Gone => TakeResult::Gone,
            land::pieces::Taken::Stale => TakeResult::Stale,
        })
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
    pub async fn take_down(&self, houses: &[i64], at: f64, writer: &Writer) -> Result<Vec<(String, CharacterId)>, String> {
        match self {
            Db::Pg(db) => land::plots::take_down(db, houses, at, lease_of(writer).as_ref()).await.map_err(|e| e.to_string()),
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
    let lease = w.writer.as_ref().and_then(lease_of);
    LifeSave {
        character: w.character,
        fence: Fence::Epoch { character: w.character, epoch: w.epoch.0 as i64 },
        life,
        land,
        space: Some(w.space.to_string()),
        lease,
    }
}

/// A writer's lease, to fence what it writes by, where leases are kept in Postgres (several processes).
fn lease_of(writer: &Writer) -> Option<crate::cluster::leases::Fence> {
    FENCED_BY_LEASES
        .load(std::sync::atomic::Ordering::Relaxed)
        .then(|| crate::cluster::leases::Fence { leased: crate::cluster::leases::Leased::space(writer.space.to_string()), epoch: writer.epoch.0 as i64 })
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
    // Their land is their life's from now until it's given back: nobody else takes a piece of it.
    db.lend(character).await?;
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
        ToStore::TakeDown { houses, at, writer } => match db.take_down(&houses, at, &writer).await {
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
        ToStore::ReturnLand { character, epoch } => {
            if let Err(e) = db.give_back(character, epoch).await {
                eprintln!("could not take character {character}'s land back: {e}");
            }
        }
        ToStore::TakePiece { piece, owner, by, epoch, reply } => {
            let result = db.take_piece(piece, owner, by, epoch).await.unwrap_or_else(|e| {
                // Not written: as if it were the owner's still.
                eprintln!("could not take piece {piece} of character {owner}'s land for {by}: {e}");
                TakeResult::Lent
            });
            post.sim(reply, ToSim::Taken { by, owner, piece, result });
        }
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

    // ---- Land (R10.21): the same rules the Postgres tests hold the SQL to (crates/server/tests/land.rs) ----

    use crate::life::housing::{DAY, demolished_at};
    use crate::life::land::{Pack, Vehicle};
    use crate::life::state::LIFE_VERSION;
    use ruina_world_api::SimId;

    /// The simulation writing in these tests, and its lease.
    fn writer() -> Option<Writer> {
        Some(Writer { sim: SimId(4), space: SpaceId::channel("emberholm", 1), epoch: Epoch(1) })
    }

    /// A life as a simulation hands it over: its state, its land beside it, where it stands.
    fn life_write(character: CharacterId, epoch: u64, state: Value, land: &Land) -> LifeWrite {
        LifeWrite {
            character,
            epoch: Epoch(epoch),
            life: json!({ "state": state, "land": land, "player": { "x": 1.0, "y": 2.0, "z": 3.0, "facing": 0.0 } }),
            space: SpaceId::channel("emberholm", 1),
            writer: writer(),
            tell: None,
        }
    }

    fn cottage(id: i64, plot: &str, tax_paid_until: f64) -> House {
        House { id, plot: plot.into(), blueprint: "cottage".into(), tax_paid_until, ..House::default() }
    }

    fn pack(id: i64, at: &str, vehicle: i64) -> Pack {
        Pack { id, def: "flaxBale".into(), at: at.into(), vehicle, x: 5.0, z: 5.0, ..Pack::default() }
    }

    /// Everything a simulation was sent.
    fn heard(sim: &std::sync::mpsc::Receiver<ToSim>) -> Vec<ToSim> {
        std::iter::from_fn(|| sim.try_recv().ok()).collect()
    }

    #[tokio::test]
    async fn a_life_is_kept_apart_from_its_land_and_the_ledgers_entries() {
        let (db, tables) = Db::memory();
        Db::tables(&tables).add_character(7, "Ada");
        let ids = db.reserve_ids().await.unwrap();
        assert_eq!((ids.next, ids.end), (BLOCK_OF_TESTS, 2 * BLOCK_OF_TESTS));
        let mut land = Land::default();
        land.houses.push(cottage(ids.next, "rise-1", 0.0));
        // A house still waiting for the registry is its claim's to write.
        land.houses.push(House { pending: true, ..cottage(ids.next + 1, "rise-2", 0.0) });
        land.packs.push(pack(ids.next + 2, "ground", 0));
        let state = json!({ "version": LIFE_VERSION, "coins": 12.0, "entries": 1,
            "ledger": [{ "n": 1, "kind": "purchase", "party": "vendor:mara", "coins": -3.0, "seals": 0.0, "items": [] }] });
        let w = life_write(7, 0, state, &land);
        assert_eq!(db.write_lives(std::slice::from_ref(&w)).await, Ok(vec![true]));
        {
            let t = Db::tables(&tables);
            // The character's row keeps the life alone: no land, no entries.
            let kept = t.characters[&7].life.clone().unwrap();
            assert!(kept.get("land").is_none());
            assert!(kept["state"].get("ledger").is_none());
            assert_eq!(kept["state"]["coins"], 12.0);
            // Its land as rows of its own; its entries as the ledger's.
            assert_eq!(t.land.keys().copied().collect::<Vec<_>>(), [ids.next, ids.next + 2]);
            assert_eq!(t.ledger.keys().map(String::as_str).collect::<Vec<_>>(), ["life:7:1"]);
        }
        // Written again (a retry): each entry once.
        assert_eq!(db.write_lives(&[w]).await, Ok(vec![true]));
        assert_eq!(Db::tables(&tables).ledger.len(), 1);
        // The writer hears the ledger has them; a write without a writer tells nobody.
        let post = crate::post::Post::new();
        let sim = post.open_sim(SimId(4));
        let again = life_write(
            7,
            0,
            json!({ "version": LIFE_VERSION, "ledger": [{ "n": 2, "kind": "sale", "party": "post:westwatch", "coins": 9.0, "seals": 0.0, "items": [] }] }),
            &land,
        );
        handle(&db, post.as_ref(), ToStore::WriteLives { writes: vec![again], then: Then::Nothing }).await;
        assert!(matches!(heard(&sim)[..], [ToSim::Recorded { character: 7, upto: 2 }]));
        // Taken up again: the life with its land beside it, and a new block of ids.
        let (s, more) = life_for(&db, 7).await.unwrap();
        let life = s.life.unwrap();
        assert_eq!(life["land"]["houses"].as_array().map(Vec::len), Some(1));
        assert_eq!(life["land"]["packs"][0]["id"], ids.next + 2);
        assert_eq!(more.next, ids.end);
        // Sold, used up: gone from the world with the next write.
        land.packs.clear();
        assert_eq!(db.write_lives(&[life_write(7, 0, json!({ "version": LIFE_VERSION }), &land)]).await, Ok(vec![true]));
        assert_eq!(Db::tables(&tables).land.keys().copied().collect::<Vec<_>>(), [ids.next]);
    }

    /// The first block of ids the store hands out.
    const BLOCK_OF_TESTS: i64 = land::BLOCK;

    #[test]
    fn a_save_from_before_land_had_rows_keeps_its_own() {
        let holding = Land { packs: vec![pack(9, "back", 0)], ..Land::default() };
        // Today's: the land beside it.
        let now = with_land(json!({ "state": { "version": LIFE_VERSION }, "player": {} }), &holding);
        assert_eq!(now["land"]["packs"][0]["id"], 9);
        // Older ones carry their own (inside the state, or beside it already): left as they are.
        let inside = json!({ "state": { "version": 3, "packs": [] }, "player": {} });
        assert_eq!(with_land(inside.clone(), &holding), inside);
        let beside = json!({ "state": { "version": LIFE_VERSION }, "land": { "packs": [] }, "player": {} });
        assert_eq!(with_land(beside.clone(), &holding), beside);
    }

    #[tokio::test]
    async fn a_plot_is_claimed_once_in_the_world_and_the_region_reads_who_holds_it() {
        let (db, tables) = Db::memory();
        {
            let mut t = Db::tables(&tables);
            t.add_character(7, "Ada");
            t.add_character(8, "Bo");
        }
        let post = crate::post::Post::new();
        let sim = post.open_sim(SimId(4));
        let claim = |character, epoch, plot: &str, id| ToStore::ClaimPlot {
            character,
            epoch: Epoch(epoch),
            plot: plot.into(),
            house: serde_json::to_value(cottage(id, plot, 0.0)).unwrap(),
            reply: SimId(4),
        };
        // Two channels race for rise-1: the first written has it, the other hears whose it is.
        handle(&db, post.as_ref(), claim(7, 0, "rise-1", 1024)).await;
        handle(&db, post.as_ref(), claim(8, 0, "rise-1", 1025)).await;
        // A grant that moved on writes nothing.
        handle(&db, post.as_ref(), claim(8, 5, "rise-2", 1026)).await;
        let said = heard(&sim);
        assert!(matches!(&said[0], ToSim::Claim { character: 7, plot, result: ClaimResult::Yours } if plot == "rise-1"));
        assert!(matches!(&said[1], ToSim::Claim { character: 8, result: ClaimResult::Theirs { holder: 7, name }, .. } if name == "Ada"));
        assert!(matches!(&said[2], ToSim::Claim { character: 8, result: ClaimResult::Stale, .. }));
        // The loser's house never reached the world.
        assert_eq!(Db::tables(&tables).land.keys().copied().collect::<Vec<_>>(), [1024]);
        // What a region's simulation reads as it starts.
        handle(&db, post.as_ref(), ToStore::LoadLand { region: "emberholm".into(), reply: SimId(4) }).await;
        let said = heard(&sim);
        let [ToSim::Land(r)] = &said[..] else { panic!("the land") };
        assert_eq!(r.claims, [("rise-1".to_string(), 7, "Ada".to_string())]);
        assert_eq!(r.holdings.iter().map(|(o, n, _)| (*o, n.as_str())).collect::<Vec<_>>(), [(7, "Ada")]);
        assert_eq!(r.holdings[0].2["houses"][0]["plot"], "rise-1");
    }

    #[tokio::test]
    async fn the_keeper_takes_down_only_houses_still_left_untaxed() {
        let (db, tables) = Db::memory();
        {
            let mut t = Db::tables(&tables);
            t.add_character(7, "Ada");
            t.add_character(8, "Bo");
        }
        let (ada, bo) = (cottage(1024, "rise-1", 0.0), cottage(1025, "rise-2", 0.0));
        assert_eq!(db.claim_plot(7, Epoch(0), "rise-1", &ada).await, Ok(ClaimResult::Yours));
        assert_eq!(db.claim_plot(8, Epoch(0), "rise-2", &bo).await, Ok(ClaimResult::Yours));
        // Bo pays a week meanwhile: his save has it.
        let paid = Land { houses: vec![cottage(1025, "rise-2", 7.0 * DAY)], ..Land::default() };
        assert_eq!(db.write_lives(&[life_write(8, 0, json!({ "version": LIFE_VERSION }), &paid)]).await, Ok(vec![true]));
        // The keeper saw both overdue: only Ada's comes down, and her plot is free.
        let at = demolished_at(&ada);
        let keeper = writer().unwrap();
        assert_eq!(db.take_down(&[1024, 1025], at, &keeper).await, Ok(vec![("rise-1".to_string(), 7)]));
        // Someone playing takes their own down (their life is their land's authority): not the keeper.
        db.lend(8).await.unwrap();
        assert_eq!(db.take_down(&[1025], 1e12, &keeper).await, Ok(Vec::new()));
        let t = Db::tables(&tables);
        assert_eq!(t.land.keys().copied().collect::<Vec<_>>(), [1025]);
        assert_eq!(t.plots.keys().map(String::as_str).collect::<Vec<_>>(), ["rise-2"]);
    }

    #[tokio::test]
    async fn a_pot_is_written_once_and_its_writer_hears_what_the_ledger_has() {
        let (db, tables) = Db::memory();
        {
            let mut t = Db::tables(&tables);
            t.add_character(7, "Ann");
            t.add_character(8, "Bea");
        }
        let post = crate::post::Post::new();
        let sim = post.open_sim(SimId(4));
        let mut gate = post.open_gate(GateId(1));
        let pot = Transfer {
            key: "pot:channel:emberholm:1:4:1:1000".into(),
            kind: "pot".into(),
            sides: vec![(7, "character:8".into(), 50.0), (8, "character:7".into(), -50.0)],
            detail: json!({ "game": "Beacons", "stake": 50.0 }),
        };
        let lives = |a: f64, b: f64| {
            let mut ann = life_write(
                7,
                0,
                json!({ "version": LIFE_VERSION, "coins": a, "ledger": [{ "n": 3, "kind": "tax", "party": "registry", "coins": -1.0, "seals": 0.0, "items": [] }] }),
                &Land::default(),
            );
            ann.tell = Some(Conn { gate: GateId(1), character: 7, session: 1 });
            vec![ann, life_write(8, 0, json!({ "version": LIFE_VERSION, "coins": b }), &Land::default())]
        };
        handle(&db, post.as_ref(), ToStore::Transfer { transfer: pot.clone(), writes: lives(250.0, 150.0) }).await;
        // Sent again (a message delivered twice): nothing more is written.
        handle(&db, post.as_ref(), ToStore::Transfer { transfer: pot, writes: lives(999.0, 0.0) }).await;
        let t = Db::tables(&tables);
        assert_eq!(t.characters[&7].life.as_ref().unwrap()["state"]["coins"], 250.0);
        assert_eq!(t.characters[&8].life.as_ref().unwrap()["state"]["coins"], 150.0);
        let rows: Vec<(&str, f64)> = t.ledger.iter().map(|(k, r)| (k.as_str(), r.coins)).collect();
        assert_eq!(rows, [("life:7:3", -1.0), ("pot:channel:emberholm:1:4:1:1000:7", 50.0), ("pot:channel:emberholm:1:4:1:1000:8", -50.0)]);
        // Ann's browser hears it's written, once; the simulation that her life is in, what the ledger has.
        assert!(matches!(gate.try_recv(), Ok(ToGate::Conn { msg: ToConn::Saved { .. }, .. })));
        assert!(gate.try_recv().is_err());
        assert!(matches!(heard(&sim)[..], [ToSim::Recorded { character: 7, upto: 3 }]));
    }

    #[tokio::test]
    async fn every_channels_sales_lower_the_worlds_demand() {
        let (db, _) = Db::memory();
        let post = crate::post::Post::new();
        let sim = post.open_sim(SimId(4));
        for _ in 0..2 {
            handle(&db, post.as_ref(), ToStore::Sold { outpost: "westwatch".into(), pack: "harvestCrate".into(), at: 1000.0 }).await;
        }
        handle(&db, post.as_ref(), ToStore::LoadMarket { reply: SimId(4) }).await;
        let said = heard(&sim);
        let [ToSim::Market(m)] = &said[..] else { panic!("the market") };
        let m: Market = serde_json::from_value(m.clone()).unwrap();
        let d = crate::life::content::demand();
        assert!((m.demand("westwatch", "harvestCrate", 1000.0) - (d.start - 2.0 * d.drop_per_sale)).abs() < 1e-9);
    }

    #[tokio::test]
    async fn a_piece_of_land_has_one_authority_its_owners_life_or_the_first_to_take_it() {
        let (db, tables) = Db::memory();
        {
            let mut t = Db::tables(&tables);
            for (id, name) in [(7, "Ada"), (8, "Bo"), (9, "Cy")] {
                t.add_character(id, name);
            }
        }
        // Ada left her cart out with a bale in its bed, and a bale on the ground, and played on.
        let mut land = Land::default();
        land.vehicles.push(Vehicle { id: 2000, def: "farmCart".into(), x: 300.0, z: -10.0, cargo: vec![2001, 0], ..Vehicle::default() });
        land.packs.push(pack(2001, "cargo", 2000));
        land.packs.push(pack(2002, "ground", 0));
        land.packs.push(pack(2003, "back", 0));
        db.lend(7).await.unwrap();
        assert_eq!(db.write_lives(&[life_write(7, 0, json!({ "version": LIFE_VERSION }), &land)]).await, Ok(vec![true]));
        // While she plays, her land is her life's: nobody takes a piece of it, from any channel.
        assert_eq!(db.take_piece(2002, 7, 8, Epoch(0)).await, Ok(TakeResult::Lent));
        // She leaves the world: her last write, then her land back to the store.
        let post = crate::post::Post::new();
        handle(&db, post.as_ref(), ToStore::ReturnLand { character: 7, epoch: Epoch(0) }).await;
        // Now the first to take the bale has it; a second finds it gone.
        let Ok(TakeResult::Yours(got)) = db.take_piece(2002, 7, 8, Epoch(0)).await else { panic!("Bo's") };
        assert_eq!(got.iter().map(|(k, d)| (k.as_str(), d["id"].as_i64())).collect::<Vec<_>>(), [("pack", Some(2002))]);
        assert_eq!(db.take_piece(2002, 7, 9, Epoch(0)).await, Ok(TakeResult::Gone));
        // A cart comes with what's in its bed; what's on her back, a house or a farm can't be taken.
        let Ok(TakeResult::Yours(cart)) = db.take_piece(2000, 7, 9, Epoch(0)).await else { panic!("Cy's") };
        assert_eq!(cart.iter().map(|(_, d)| d["id"].as_i64().unwrap()).collect::<Vec<_>>(), [2000, 2001]);
        assert_eq!(db.take_piece(2003, 7, 9, Epoch(0)).await, Ok(TakeResult::Gone));
        // A taker whose grant moved on takes nothing.
        assert_eq!(db.take_piece(2003, 7, 9, Epoch(4)).await, Ok(TakeResult::Stale));
        // What she comes back to is what's still hers; her old copy can't write the rest back.
        assert_eq!(db.holding(7).await.unwrap().packs.iter().map(|p| p.id).collect::<Vec<_>>(), [2003]);
        assert_eq!(db.write_lives(&[life_write(7, 0, json!({ "version": LIFE_VERSION }), &land)]).await, Ok(vec![true]));
        {
            let t = Db::tables(&tables);
            assert_eq!(t.land.iter().map(|(id, r)| (*id, r.owner)).collect::<Vec<_>>(), [(2000, 9), (2001, 9), (2002, 8), (2003, 7)]);
        }
        // A newer window's lend stays when an older one gives back.
        Db::tables(&tables).characters.get_mut(&7).unwrap().epoch = 2;
        db.lend(7).await.unwrap();
        db.give_back(7, Epoch(1)).await.unwrap();
        assert_eq!(db.take_piece(2003, 7, 8, Epoch(0)).await, Ok(TakeResult::Lent));
    }
}
