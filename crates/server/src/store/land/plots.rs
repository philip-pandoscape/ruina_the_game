//! House plots: one claim each in the world, first come (migration 0011). The table's primary key is
//! the registry: of two claims on a plot, from any channel or server, the first written is kept and
//! the other finds it taken (the engine then takes that house down again: housing::lose_claim). A
//! claim is the house on the plot, so a house taken down frees its plot, whoever takes it down: its
//! owner's save without it, or the region's keeper (`take_down`).

use std::collections::BTreeMap;

use serde_json::Value;
use sqlx::PgPool;
use sqlx::types::Json;

use super::{Fence, SPACE, WORLD, current, write_row};
use crate::life::housing::neglected;
use crate::life::land::{House, Kind, Land, Row};

/// What became of a claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Claim {
    /// The plot is yours; the house on it is in the world.
    Yours,
    /// Someone else claimed it first: theirs (`holder`, and their name).
    Theirs { holder: i64, name: String },
    /// The grant it was made under isn't current any more: nothing was written.
    Stale,
}

/// Claims `plot` for `owner`, with the house just put on it: its row and the claim, in one
/// transaction, or neither. Claiming a plot you hold already just brings its house's row up to date.
pub async fn claim(db: &PgPool, plot: &str, owner: i64, fence: Fence, house: &House) -> Result<Claim, sqlx::Error> {
    let mut tx = db.begin().await?;
    if !current(&mut tx, fence).await? {
        return Ok(Claim::Stale);
    }
    let land = Land { houses: vec![house.clone()], ..Land::default() };
    let row: Row = land.rows().remove(0);
    write_row(&mut tx, owner, fence.epoch(), &row).await?;
    let held: Option<i64> = sqlx::query_scalar(
        "INSERT INTO plots (world, plot, holder, house, epoch) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (world, plot) DO UPDATE SET house = EXCLUDED.house WHERE plots.holder = EXCLUDED.holder \
         RETURNING holder",
    )
    .bind(WORLD)
    .bind(plot)
    .bind(owner)
    .bind(house.id)
    .bind(fence.epoch())
    .fetch_optional(&mut *tx)
    .await?;
    if held.is_some() {
        tx.commit().await?;
        return Ok(Claim::Yours);
    }
    tx.rollback().await?;
    let (holder, name): (i64, String) =
        sqlx::query_as("SELECT p.holder, c.name FROM plots p JOIN characters c ON c.id = p.holder WHERE p.world = $1 AND p.plot = $2")
            .bind(WORLD)
            .bind(plot)
            .fetch_one(db)
            .await?;
    Ok(Claim::Theirs { holder, name })
}

/// Who holds each plot in the world: plot -> (their character, their name).
pub async fn claims(db: &PgPool) -> Result<BTreeMap<String, (i64, String)>, sqlx::Error> {
    let rows: Vec<(String, i64, String)> =
        sqlx::query_as("SELECT p.plot, p.holder, c.name FROM plots p JOIN characters c ON c.id = p.holder WHERE p.world = $1")
            .bind(WORLD)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(plot, holder, name)| (plot, (holder, name))).collect())
}

/// Every house standing in the world, with whose it is: what the region's keeper looks over for
/// tax gone unpaid too long (crate::life::housing::demolish_neglected).
pub async fn houses(db: &PgPool) -> Result<Vec<(i64, House)>, sqlx::Error> {
    let rows: Vec<(i64, Json<Value>)> = sqlx::query_as("SELECT owner, data FROM land WHERE world = $1 AND space = $2 AND kind = $3 ORDER BY id")
        .bind(WORLD)
        .bind(SPACE)
        .bind(Kind::House.name())
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().filter_map(|(owner, Json(data))| serde_json::from_value(data).ok().map(|h| (owner, h))).collect())
}

/// Takes these houses down, their tax unpaid too long at `at` (the world's clock): each one that still
/// is, as the rows have it (an owner who paid meanwhile has written a later `tax_paid_until`, and
/// keeps theirs; one taken down already is gone). Their rows go, and with them their plots' claims.
/// The plots let go, with whose they were. Under the region keeper's lease where leases are kept in
/// Postgres (`lease`): a keeper that lost its space takes nothing down.
pub async fn take_down(db: &PgPool, ids: &[i64], at: f64, lease: Option<&crate::cluster::leases::Fence>) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let mut tx = db.begin().await?;
    if let Some(lease) = lease
        && crate::cluster::leases::check(&mut tx, lease).await?.is_err()
    {
        return Ok(Vec::new());
    }
    let rows: Vec<(i64, Json<Value>)> = sqlx::query_as("SELECT id, data FROM land WHERE world = $1 AND kind = $2 AND id = ANY($3) FOR UPDATE")
        .bind(WORLD)
        .bind(Kind::House.name())
        .bind(ids)
        .fetch_all(&mut *tx)
        .await?;
    let gone: Vec<i64> =
        rows.into_iter().filter(|(_, Json(d))| serde_json::from_value::<House>(d.clone()).is_ok_and(|h| neglected(&h, at))).map(|(id, _)| id).collect();
    let freed: Vec<(String, i64)> =
        sqlx::query_as("SELECT plot, holder FROM plots WHERE world = $1 AND house = ANY($2) ORDER BY plot").bind(WORLD).bind(&gone).fetch_all(&mut *tx).await?;
    sqlx::query("DELETE FROM land WHERE world = $1 AND id = ANY($2)").bind(WORLD).bind(&gone).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(freed)
}

/// Whether `plot` is held, and by whom.
pub async fn holder(db: &PgPool, plot: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT holder FROM plots WHERE world = $1 AND plot = $2").bind(WORLD).bind(plot).fetch_optional(db).await
}
