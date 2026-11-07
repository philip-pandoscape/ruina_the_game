//! The ledger (migration 0012): value moving between a character and the world, or between two
//! characters, each written once. A row is one character's side of a transfer, keyed by which
//! transfer and whose side it is, so a transfer sent twice (a retry, a message delivered again) is
//! applied once: its rows and the lives it changes are written in one transaction, or nothing is.
//!
//! - A life's own entries (purchases, sales, payouts, fees, taxes, rewards: crate::life::state::Entry)
//!   go with its save (`record`), keyed `life:<character>:<n>`: a save written twice records them
//!   once.
//! - A transfer between characters (a mini-game's pot) is `transfer`: its rows, and both lives as
//!   they are once it's paid, in one transaction under its own key.

use serde_json::{Value, json};
use sqlx::types::Json;
use sqlx::{PgPool, Postgres, Transaction};

use super::{LifeSave, WORLD, save_in};
use crate::life::state::{Entry, Stack};

/// One character's side of a transfer: what they gained (negative for what they gave), and who it
/// was with.
#[derive(Clone, Debug, PartialEq)]
pub struct Side {
    pub character: i64,
    /// "character:<id>" for another character; the world's people as a life names them.
    pub party: String,
    pub coins: f64,
    pub seals: f64,
    pub items: Vec<Stack>,
}

/// A transfer between characters: which one it is (`key`, the same however often it's sent), what
/// kind, each side of it, and what it was for.
#[derive(Clone, Debug, PartialEq)]
pub struct Transfer {
    pub key: String,
    pub kind: String,
    pub sides: Vec<Side>,
    pub detail: Value,
}

/// What became of a transfer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Applied {
    /// Written now, with which of the lives were (one whose grant is no longer current isn't: its
    /// newer connection has the life, and saves it).
    Now(Vec<bool>),
    /// It was written before: nothing is written again.
    Already,
}

/// A pot of `stake` from each of two players, won by `winner` (its key names the table and the
/// game played at it).
pub fn pot(key: &str, winner: i64, loser: i64, stake: f64, game: &str) -> Transfer {
    let side = |character: i64, other: i64, coins: f64| Side { character, party: format!("character:{other}"), coins, seals: 0.0, items: Vec::new() };
    Transfer {
        key: key.to_string(),
        kind: "pot".into(),
        sides: vec![side(winner, loser, stake), side(loser, winner, -stake)],
        detail: json!({ "game": game, "stake": stake }),
    }
}

/// Writes a transfer and the lives it changes, in one transaction: once. Sent again with the same
/// key, nothing is written (`Applied::Already`), whatever the lives sent with it say.
pub async fn transfer(db: &PgPool, t: &Transfer, saves: &[LifeSave]) -> Result<Applied, sqlx::Error> {
    let mut tx = db.begin().await?;
    for (k, side) in t.sides.iter().enumerate() {
        let key = format!("{}:{}", t.key, side.character);
        if !insert(&mut tx, &key, side, &t.kind, &t.detail).await? {
            if k == 0 {
                tx.rollback().await?;
                return Ok(Applied::Already);
            }
            // Half of it there already can't happen (each transfer's rows go in together), but a
            // second write must never add to it.
            tx.rollback().await?;
            return Ok(Applied::Already);
        }
    }
    let written = save_in(&mut tx, saves).await?;
    tx.commit().await?;
    Ok(Applied::Now(written))
}

/// A life's own entries, written in `tx` with its save: each once, by its number.
pub async fn record(tx: &mut Transaction<'_, Postgres>, character: i64, entries: &[Entry]) -> Result<(), sqlx::Error> {
    for e in entries {
        let side = Side { character, party: e.party.clone(), coins: e.coins, seals: e.seals, items: e.items.clone() };
        let detail = e.detail.as_ref().map_or(Value::Null, |d| json!({ "for": d }));
        insert(tx, &format!("life:{character}:{}", e.n), &side, &e.kind, &detail).await?;
    }
    Ok(())
}

/// One side's row. False if a row with its key is there already.
async fn insert(tx: &mut Transaction<'_, Postgres>, key: &str, side: &Side, kind: &str, detail: &Value) -> Result<bool, sqlx::Error> {
    let id: Option<i64> = sqlx::query_scalar(
        "INSERT INTO ledger (key, world, character, party, kind, coins, seals, items, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (key) DO NOTHING RETURNING id",
    )
    .bind(key)
    .bind(WORLD)
    .bind(side.character)
    .bind(&side.party)
    .bind(kind)
    .bind(side.coins)
    .bind(side.seals)
    .bind(Json(&side.items))
    .bind(if detail.is_null() { None } else { Some(Json(detail)) })
    .fetch_optional(&mut **tx)
    .await?;
    Ok(id.is_some())
}

/// A character's rows, oldest first: (key, kind, party, coins, seals).
pub async fn of(db: &PgPool, character: i64) -> Result<Vec<(String, String, String, f64, f64)>, sqlx::Error> {
    sqlx::query_as("SELECT key, kind, party, coins, seals FROM ledger WHERE world = $1 AND character = $2 ORDER BY id")
        .bind(WORLD)
        .bind(character)
        .fetch_all(db)
        .await
}
