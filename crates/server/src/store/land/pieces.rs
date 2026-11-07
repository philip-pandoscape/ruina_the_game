//! Who may change a piece of someone's land: one authority at a time (migration 0014).
//!
//! - **While its owner plays**, their land is lent to their life (`lend`, as the store reads it for
//!   the connection taking them up), and that life alone changes it, in the one simulation playing
//!   them: its writes are fenced by the owner's epoch. Anyone else acts on it there, through that
//!   simulation (riding along in a vehicle needs its owner there to drive it).
//! - **While they're away** (`give_back`, after their life's last write), the store keeps it, and
//!   whoever acts on a piece of it from any channel or server takes it from the store (`take`): a
//!   pack on the ground, or a vehicle with what's in its bed. The first to ask has it; a second finds
//!   it gone, as the owner does when they come back (their land is read from its rows).
//!
//! The memory tables keep the same rule (crate::store::memory).

use serde_json::Value;
use sqlx::PgPool;
use sqlx::types::Json;

use super::WORLD;
use crate::life::land::Kind;

/// What became of taking a piece.
#[derive(Clone, Debug, PartialEq)]
pub enum Taken {
    /// It's the taker's now: the rows taken (a vehicle with the packs in its bed).
    Yours(Vec<(Kind, Value)>),
    /// Its owner is playing: their land is lent to their life.
    Lent,
    /// It isn't the owner's any more, or it's nothing that can be taken.
    Gone,
    /// The taker's grant isn't current: nothing was written.
    Stale,
}

/// Lends a character's land to the life read for them now, under their current grant.
pub async fn lend(db: &PgPool, character: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE characters SET land_lent = epoch WHERE id = $1").bind(character).execute(db).await?;
    Ok(())
}

/// A character's land back from the life it was lent to, under the grant that life was played under
/// (a lend since, to a newer window, stays).
pub async fn give_back(db: &PgPool, character: i64, epoch: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE characters SET land_lent = NULL WHERE id = $1 AND land_lent <= $2").bind(character).bind(epoch).execute(db).await?;
    Ok(())
}

/// Everyone's land back: a server started alone, before anyone plays.
pub async fn all_back(db: &PgPool) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query("UPDATE characters SET land_lent = NULL WHERE land_lent IS NOT NULL").execute(db).await?.rows_affected())
}

/// Takes piece `piece` of `owner`'s land for `by`, under `by`'s grant `epoch`, in one transaction:
/// only while `owner`'s land isn't lent, and only if the piece is still theirs and can be taken (a
/// pack on the ground, or a vehicle, which brings what's in its bed).
pub async fn take(db: &PgPool, piece: i64, owner: i64, by: i64, epoch: i64) -> Result<Taken, sqlx::Error> {
    let mut tx = db.begin().await?;
    let taker: Option<i64> =
        sqlx::query_scalar("SELECT id FROM characters WHERE id = $1 AND epoch = $2 FOR UPDATE").bind(by).bind(epoch).fetch_optional(&mut *tx).await?;
    if taker.is_none() {
        return Ok(Taken::Stale);
    }
    let lent: Option<Option<i64>> =
        sqlx::query_scalar("SELECT land_lent FROM characters WHERE id = $1 FOR UPDATE").bind(owner).fetch_optional(&mut *tx).await?;
    if matches!(lent, Some(Some(_))) {
        return Ok(Taken::Lent);
    }
    let row: Option<(String, Json<Value>)> = sqlx::query_as("SELECT kind, data FROM land WHERE id = $1 AND owner = $2 AND world = $3 FOR UPDATE")
        .bind(piece)
        .bind(owner)
        .bind(WORLD)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((kind, Json(data))) = row else { return Ok(Taken::Gone) };
    let Some(kind) = Kind::named(&kind).filter(|k| takeable(*k, &data)) else { return Ok(Taken::Gone) };
    let mut taken = vec![(kind, data)];
    if kind == Kind::Vehicle {
        // What's in its bed goes with it.
        let cargo: Vec<(i64, Json<Value>)> = sqlx::query_as(
            "SELECT id, data FROM land WHERE owner = $1 AND world = $2 AND kind = $3 AND data->>'at' = 'cargo' AND (data->>'vehicle')::bigint = $4 FOR UPDATE",
        )
        .bind(owner)
        .bind(WORLD)
        .bind(Kind::Pack.name())
        .bind(piece)
        .fetch_all(&mut *tx)
        .await?;
        for (id, Json(d)) in cargo {
            sqlx::query("UPDATE land SET owner = $2, epoch = $3, changed_at = now() WHERE id = $1").bind(id).bind(by).bind(epoch).execute(&mut *tx).await?;
            taken.push((Kind::Pack, d));
        }
    }
    sqlx::query("UPDATE land SET owner = $2, epoch = $3, changed_at = now() WHERE id = $1").bind(piece).bind(by).bind(epoch).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Taken::Yours(taken))
}

/// Whether a piece can be taken by someone else: a pack on the ground, or a vehicle. (A house, a
/// farm or a ship on the slipway stays its owner's; a pack on their back or in a bed goes with them.)
pub fn takeable(kind: Kind, data: &Value) -> bool {
    match kind {
        Kind::Pack => data.get("at").and_then(Value::as_str) == Some("ground"),
        Kind::Vehicle => true,
        _ => false,
    }
}
