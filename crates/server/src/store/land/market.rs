//! The world's market (migration 0013): each trading post's demand for each pack, kept in one place
//! for every channel and server. A sale lowers it in one statement, worked out as the engine works it
//! out (crate::life::market::Market::sell: what it had recovered to by the sale's moment, less a
//! sale's drop, never below the floor), so two sales from two servers at once both count.

use std::collections::BTreeMap;

use sqlx::PgPool;

use super::WORLD;
use crate::life::content;
use crate::life::market::{Demand, Market, key};

/// The market as the database keeps it.
pub async fn load(db: &PgPool) -> Result<Market, sqlx::Error> {
    let rows: Vec<(String, String, f64, f64)> =
        sqlx::query_as("SELECT outpost, pack, demand, at FROM market WHERE world = $1").bind(WORLD).fetch_all(db).await?;
    let demand: BTreeMap<String, Demand> = rows.into_iter().map(|(o, p, value, at)| (key(&o, &p), Demand { value, at })).collect();
    Ok(Market { demand })
}

/// A pack sold at a trading post at `at` (the world's clock): its demand there as it now stands.
pub async fn sold(db: &PgPool, outpost: &str, pack: &str, at: f64) -> Result<Demand, sqlx::Error> {
    let d = content::demand();
    let (value, at): (f64, f64) = sqlx::query_as(
        "INSERT INTO market (world, outpost, pack, demand, at) VALUES ($1, $2, $3, GREATEST($4, $5 - $6), $7) \
         ON CONFLICT (world, outpost, pack) DO UPDATE SET \
           demand = GREATEST($4, LEAST($8, market.demand + $9 * GREATEST(0, EXCLUDED.at - market.at) / 60) - $6), \
           at = GREATEST(market.at, EXCLUDED.at) \
         RETURNING demand, at",
    )
    .bind(WORLD)
    .bind(outpost)
    .bind(pack)
    .bind(d.min)
    .bind(d.start)
    .bind(d.drop_per_sale)
    .bind(at)
    .bind(d.max)
    .bind(d.recover_per_minute)
    .fetch_one(db)
    .await?;
    Ok(Demand { value, at })
}
