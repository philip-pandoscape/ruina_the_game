//! The store's side of land (R10.21): what's built and planted in the world, the house plots, the
//! ledger and the world's market, as Postgres keeps them (migrations 0010-0013). The rules are the
//! engine's (crates/engine/src/life/land.rs, housing.rs, market.rs); here is only how they're kept.
//! The store's messages reach them through `Db` (crate::store), which keeps the same rows in memory
//! for the tests (crate::store::memory).
//!
//! Each function is one write or read the store makes, in its own transaction: a life saved with
//! the land lent to it (`save`), a plot claimed (`plots::claim`), houses taken down
//! (`plots::take_down`), a transfer (`ledger::transfer`), a sale (`market::sold`), a block of ids
//! (`reserve_ids`), and what a region's simulation reads (`load_land`, `load_holding`). Every write
//! about a character is fenced by their grant (`Fence`: `characters.epoch`) and refused if a newer
//! one was made since. A character's writes reach the store in the order they were made (the
//! simulation's one queue), as a save made before a claim would otherwise take the claimed house
//! down again.
//!
//! - `plots`: one claim per plot in the world, first come.
//! - `ledger`: transfers, each applied once, with the lives they change.
//! - `market`: each trading post's demand, the world's.
//! - `migrate`: saves from before land had rows of its own, moved into them as the server starts.
//! - `pieces`: who may change a piece of land: the life it's lent to, or whoever takes it first.
//!
//! Tested against a real Postgres: crates/server/tests/land.rs.

pub mod ledger;
pub mod market;
pub mod migrate;
pub mod pieces;
pub mod plots;

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use sqlx::types::Json;
use sqlx::{PgPool, Postgres, Transaction};

use crate::life::land::{Ids, Kind, Land};
use crate::life::state::Entry;

/// The world a database keeps (one, today).
pub const WORLD: &str = "ruina";
/// The open world, the only space land stands in (an instance's copies keep none).
pub const SPACE: &str = "world";
/// Ids in a block of `land_blocks` (hi/lo: block b holds b * BLOCK up to (b + 1) * BLOCK).
pub const BLOCK: i64 = 1024;

/// Whose grant a write is made under: the store makes it only while that grant is current, so a
/// window that was replaced, or a simulation that no longer plays the character, can never write
/// over newer work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fence {
    /// The character's grant (`characters.epoch`, bumped by the directory for every new window and
    /// every move to another simulation): their life, the land lent to it, a plot they claim.
    Epoch { character: i64, epoch: i64 },
    /// Nobody's grant: the save migration as the server starts, before anyone plays, and tests.
    Open,
}

impl Fence {
    /// The epoch kept with what it writes.
    pub fn epoch(self) -> i64 {
        match self {
            Fence::Epoch { epoch, .. } => epoch,
            Fence::Open => 0,
        }
    }
}

/// Whether `fence` is still current, in `tx`, holding the character's row until the transaction ends.
pub async fn current(tx: &mut Transaction<'_, Postgres>, fence: Fence) -> Result<bool, sqlx::Error> {
    match fence {
        Fence::Open => Ok(true),
        Fence::Epoch { character, epoch } => {
            let row: Option<i64> = sqlx::query_scalar("SELECT id FROM characters WHERE id = $1 AND epoch = $2 FOR UPDATE")
                .bind(character)
                .bind(epoch)
                .fetch_optional(&mut **tx)
                .await?;
            Ok(row.is_some())
        }
    }
}

/// A block of ids for pieces no other piece in the world has: the run a holding names what it
/// places from (`Land::ids`).
pub async fn reserve_ids(db: &PgPool) -> Result<Ids, sqlx::Error> {
    let block: i64 = sqlx::query_scalar("SELECT nextval('land_blocks')").fetch_one(db).await?;
    Ok(Ids { next: block * BLOCK, end: (block + 1) * BLOCK })
}

/// A life to save: whose, under which grant, the life as kept (`{state, player}`, the ledger's
/// entries it holds still in its state), the land lent to it if it's written with it, the space its
/// position is in (None: where it was), and the writing simulation's lease where leases are kept in
/// Postgres (several processes: crate::cluster::leases), which must still be current too.
#[derive(Clone, Debug)]
pub struct LifeSave {
    pub character: i64,
    pub fence: Fence,
    pub life: Value,
    pub land: Option<Land>,
    pub space: Option<String>,
    pub lease: Option<crate::cluster::leases::Fence>,
}

/// A life as a simulation hands it over (`{state, land, player}`) taken apart: the life as it's kept
/// on the character's row, and the land lent to it (None if it has none beside it: a test's, or one
/// whose land can't be read, which leaves the rows as they are).
pub fn split(life: &Value) -> (Value, Option<Land>) {
    let mut kept = life.clone();
    let mut land = None;
    if let Some(o) = kept.as_object_mut() {
        if let Some(l) = o.remove("land").filter(|l| !l.is_null()) {
            match serde_json::from_value::<Land>(l) {
                Ok(l) => land = Some(l),
                Err(e) => eprintln!("a life's land can't be read ({e}): its rows are left as they are"),
            }
        }
        o.remove("ids");
    }
    (kept, land)
}

/// The life as it's kept on the character's row, without the ledger's entries (they're rows of
/// their own, written with it), and those entries.
pub fn without_ledger(life: &Value) -> (Value, Vec<Entry>) {
    let mut kept = life.clone();
    let entries = kept
        .get_mut("state")
        .and_then(Value::as_object_mut)
        .and_then(|st| st.remove("ledger"))
        .and_then(|l| serde_json::from_value(l).ok())
        .unwrap_or_default();
    (kept, entries)
}

/// The highest number among the ledger's entries a life holds: once it's written, the life may
/// forget them (`Life::recorded`).
pub fn last_entry(life: &Value) -> Option<u64> {
    life.get("state")?.get("ledger")?.as_array()?.iter().filter_map(|e| e.get("n")?.as_u64()).max()
}

/// The ids of a holding's houses still waiting for the registry: their rows are the claim's to
/// write (`plots::claim`), so a save neither writes nor removes them.
pub fn waiting(land: &Land) -> BTreeSet<i64> {
    land.houses.iter().filter(|h| h.pending).map(|h| h.id).collect()
}

/// Saves lives, each with the land lent to it and what it kept for the ledger, in one transaction:
/// each one kept or none of it. Whether each was written (one whose grant is no longer current
/// isn't). Once one is, its life may forget the ledger's entries it held (`Life::recorded`).
pub async fn save(db: &PgPool, saves: &[LifeSave]) -> Result<Vec<bool>, sqlx::Error> {
    let mut tx = db.begin().await?;
    let written = save_in(&mut tx, saves).await?;
    tx.commit().await?;
    Ok(written)
}

/// The same, in a transaction already begun (a transfer's).
pub async fn save_in(tx: &mut Transaction<'_, Postgres>, saves: &[LifeSave]) -> Result<Vec<bool>, sqlx::Error> {
    let mut written = Vec::with_capacity(saves.len());
    for s in saves {
        // Among several processes, the writing simulation's lease too: one that lost its space can't
        // write, even a life nobody has been granted anew.
        if let Some(lease) = &s.lease
            && crate::cluster::leases::check(tx, lease).await?.is_err()
        {
            written.push(false);
            continue;
        }
        if !current(tx, s.fence).await? {
            written.push(false);
            continue;
        }
        let (island, entries) = without_ledger(&s.life);
        let done = sqlx::query("UPDATE characters SET island = $2, saved_at = now(), space = COALESCE($3, space) WHERE id = $1")
            .bind(s.character)
            .bind(Json(&island))
            .bind(&s.space)
            .execute(&mut **tx)
            .await?;
        if done.rows_affected() == 1 {
            if let Some(land) = &s.land {
                write_holding(tx, s.character, s.fence.epoch(), land).await?;
            }
            // What the life kept for the ledger goes in with it, each entry once.
            ledger::record(tx, s.character, &entries).await?;
        }
        written.push(done.rows_affected() == 1);
    }
    Ok(written)
}

/// Writes one character's land as it now is: each piece's row (where it stands now, and what it
/// is), and none of theirs that the land no longer has (sold, used up, recalled, taken down; a
/// house's plot goes with it). A house still waiting for the registry is the claim's to write.
pub async fn write_holding(tx: &mut Transaction<'_, Postgres>, owner: i64, epoch: i64, land: &Land) -> Result<(), sqlx::Error> {
    let waiting = waiting(land);
    let rows = land.rows();
    for r in rows.iter().filter(|r| !(r.kind == Kind::House && waiting.contains(&r.id))) {
        write_row(tx, owner, epoch, r).await?;
    }
    let keep: Vec<i64> = rows.iter().map(|r| r.id).collect();
    sqlx::query("DELETE FROM land WHERE owner = $1 AND world = $2 AND space = $3 AND NOT (id = ANY($4))")
        .bind(owner)
        .bind(WORLD)
        .bind(SPACE)
        .bind(&keep)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// One piece's row, put in or brought up to date (only ever its own owner's).
pub async fn write_row(tx: &mut Transaction<'_, Postgres>, owner: i64, epoch: i64, r: &crate::life::land::Row) -> Result<(), sqlx::Error> {
    let (cx, cz) = r.chunk.map_or((None, None), |(x, z)| (Some(x), Some(z)));
    sqlx::query(
        "INSERT INTO land (id, world, space, cx, cz, kind, owner, epoch, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (id) DO UPDATE SET cx = EXCLUDED.cx, cz = EXCLUDED.cz, kind = EXCLUDED.kind, epoch = EXCLUDED.epoch, \
           data = EXCLUDED.data, changed_at = now() \
         WHERE land.owner = EXCLUDED.owner",
    )
    .bind(r.id)
    .bind(WORLD)
    .bind(SPACE)
    .bind(cx)
    .bind(cz)
    .bind(r.kind.name())
    .bind(owner)
    .bind(epoch)
    .bind(Json(&r.data))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

type LandRow = (i64, String, Json<Value>);

/// Everyone's land in the world, or in these chunks only, by owner: what a region's keeper reads of
/// its chunks (a pack on someone's back stands in no chunk, and is read with them: `load_holding`).
pub async fn load_land(db: &PgPool, chunks: Option<&[(i32, i32)]>) -> Result<BTreeMap<i64, Land>, sqlx::Error> {
    let rows: Vec<LandRow> = match chunks {
        None => {
            sqlx::query_as("SELECT owner, kind, data FROM land WHERE world = $1 AND space = $2 ORDER BY owner, id")
                .bind(WORLD)
                .bind(SPACE)
                .fetch_all(db)
                .await?
        }
        Some(list) => {
            let (xs, zs): (Vec<i32>, Vec<i32>) = list.iter().copied().unzip();
            sqlx::query_as(
                "SELECT owner, kind, data FROM land WHERE world = $1 AND space = $2 \
                 AND (cx, cz) IN (SELECT * FROM unnest($3::int[], $4::int[])) ORDER BY owner, id",
            )
            .bind(WORLD)
            .bind(SPACE)
            .bind(&xs)
            .bind(&zs)
            .fetch_all(db)
            .await?
        }
    };
    let mut by_owner: BTreeMap<i64, Vec<(Kind, Value)>> = BTreeMap::new();
    for (owner, kind, Json(data)) in rows {
        if let Some(k) = Kind::named(&kind) {
            by_owner.entry(owner).or_default().push((k, data));
        }
    }
    Ok(by_owner.into_iter().map(|(owner, rows)| (owner, Land::from_rows(rows).0)).collect())
}

/// Characters' names, by id.
pub async fn names(db: &PgPool, ids: &[i64]) -> Result<BTreeMap<i64, String>, sqlx::Error> {
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, name FROM characters WHERE id = ANY($1)").bind(ids).fetch_all(db).await?;
    Ok(rows.into_iter().collect())
}

/// Everything of one character's in the world: the land lent to their life when they play.
pub async fn load_holding(db: &PgPool, owner: i64) -> Result<Land, sqlx::Error> {
    let rows: Vec<(String, Json<Value>)> = sqlx::query_as("SELECT kind, data FROM land WHERE owner = $1 AND world = $2 AND space = $3 ORDER BY id")
        .bind(owner)
        .bind(WORLD)
        .bind(SPACE)
        .fetch_all(db)
        .await?;
    let (land, bad) = Land::from_rows(rows.into_iter().filter_map(|(k, Json(d))| Kind::named(&k).map(|k| (k, d))));
    for b in bad {
        eprintln!("character {owner}: a piece of land that can't be read is left where it is: {b}");
    }
    Ok(land)
}
