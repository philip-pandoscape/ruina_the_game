//! The directory's leases in Postgres (`space_leases`, migration 0030): which simulation plays each
//! space, under which epoch, until when.
//!
//! - **A grant** (`acquire`) bumps the epoch, in one statement that can't race: of several
//!   simulations asking at once for a space nobody holds, one gets it.
//! - **The holder renews** (`renew`) about every 2 s a lease of about 10 s, and only while it hasn't
//!   run out; a sim that can't renew stops before it does (`keeper.rs`).
//! - **A lease not renewed runs out**, and the next to ask takes the space under the next epoch.
//! - **Every write is fenced** (`check`, inside the write's transaction): it carries the epoch its
//!   space was granted under, and is refused once a newer grant has been made. The check takes the
//!   lease's row FOR SHARE, so a grant waits for writes under the old epoch to commit, and whoever
//!   takes the space over reads after them (Kleppmann's fencing tokens; `characters.live_session`
//!   was the first of them, and the character's own epoch is the store's).
//!
//! The database's clock decides when a lease runs out; the holder measures its own time from when
//! it asked (`keeper.rs`), so it stops first whatever the two clocks say.

use std::fmt;
use std::time::Duration;

use sqlx::{PgConnection, PgPool, Row};

/// What a lease is on: a space (world-api's `SpaceId` as its key), or a part of one (a region split
/// between simulations: part 0 is the whole space).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Leased {
    pub space: String,
    pub part: i32,
}

impl Leased {
    /// A whole space.
    pub fn space(key: impl Into<String>) -> Leased {
        Leased { space: key.into(), part: 0 }
    }
}

impl fmt::Display for Leased {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.part == 0 { f.write_str(&self.space) } else { write!(f, "{}#{}", self.space, self.part) }
    }
}

/// Who asks for a lease: a simulation (its id, from `sim_ids`), in a process (the node), whose
/// links take messages at an address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Holder {
    pub sim: i64,
    pub node: String,
    pub address: String,
}

/// A lease held: what, by which simulation, under which epoch. Its fence is what every write about
/// the space carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lease {
    pub leased: Leased,
    pub sim: i64,
    pub epoch: i64,
}

impl Lease {
    pub fn fence(&self) -> Fence {
        Fence { leased: self.leased.clone(), epoch: self.epoch }
    }
}

/// What a write about a space carries: the space and the epoch its writer was granted it under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fence {
    pub leased: Leased,
    pub epoch: i64,
}

/// Who holds a space now, as the directory says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub sim: i64,
    pub node: String,
    pub address: String,
    pub epoch: i64,
    /// How long until the lease runs out unless renewed.
    pub left: Duration,
}

/// The answer to asking for a lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Granted {
    Yes(Lease),
    /// Someone else holds it, for now.
    Held(Owner),
}

/// A write refused: a newer grant has been made since its epoch (or the lease was let go).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stale {
    pub fence: Fence,
    /// The space's epoch now.
    pub now: Option<i64>,
}

impl fmt::Display for Stale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.now {
            Some(now) => write!(f, "a write to {} under epoch {} refused: it's at epoch {now}", self.fence.leased, self.fence.epoch),
            None => write!(f, "a write to {} under epoch {} refused: nobody holds it", self.fence.leased, self.fence.epoch),
        }
    }
}

fn millis(d: Duration) -> i64 {
    d.as_millis().min(i64::MAX as u128) as i64
}

/// A new simulation's id: unique across every process on this database, never used again.
pub async fn new_sim(db: &PgPool) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT nextval('sim_ids')").fetch_one(db).await
}

/// Asks for `leased` for `holder`, for `ttl`: granted (under the next epoch) if nobody holds it or
/// its lease has run out; else who holds it. `chunks`: the 256 m chunks a part owns (none for a
/// whole space).
pub async fn acquire(db: &PgPool, leased: &Leased, holder: &Holder, chunks: &[(i32, i32)], ttl: Duration) -> sqlx::Result<Granted> {
    let chunks = serde_json::Value::from(chunks.iter().map(|(x, z)| serde_json::json!([x, z])).collect::<Vec<_>>());
    loop {
        // In READ COMMITTED, ON CONFLICT DO UPDATE locks the row and checks its WHERE against the
        // row as it is now, so two asking at once can't both be granted.
        let granted: Option<i64> = sqlx::query_scalar(
            "INSERT INTO space_leases AS l (space, part, chunks, sim, node, address, epoch, expires_at, granted_at, renewed_at) \
             VALUES ($1, $2, $3, $4, $5, $6, 1, now() + $7 * interval '1 millisecond', now(), now()) \
             ON CONFLICT (space, part) DO UPDATE \
               SET chunks = EXCLUDED.chunks, sim = EXCLUDED.sim, node = EXCLUDED.node, address = EXCLUDED.address, \
                   epoch = l.epoch + 1, expires_at = EXCLUDED.expires_at, granted_at = now(), renewed_at = now() \
             WHERE l.sim IS NULL OR l.expires_at <= now() \
             RETURNING epoch",
        )
        .bind(&leased.space)
        .bind(leased.part)
        .bind(sqlx::types::Json(&chunks))
        .bind(holder.sim)
        .bind(&holder.node)
        .bind(&holder.address)
        .bind(millis(ttl))
        .fetch_optional(db)
        .await?;
        if let Some(epoch) = granted {
            return Ok(Granted::Yes(Lease { leased: leased.clone(), sim: holder.sim, epoch }));
        }
        if let Some(o) = owner(db, leased).await? {
            return Ok(Granted::Held(o));
        }
        // Run out or let go between the two statements: ask again.
    }
}

/// Renews a lease for another `ttl`, if it's still this one's and hasn't run out. False: lost (run
/// out, or taken over), and the holder must stop at once.
pub async fn renew(db: &PgPool, lease: &Lease, ttl: Duration) -> sqlx::Result<bool> {
    let r = sqlx::query(
        "UPDATE space_leases SET expires_at = now() + $5 * interval '1 millisecond', renewed_at = now() \
         WHERE space = $1 AND part = $2 AND epoch = $3 AND sim = $4 AND expires_at > now()",
    )
    .bind(&lease.leased.space)
    .bind(lease.leased.part)
    .bind(lease.epoch)
    .bind(lease.sim)
    .bind(millis(ttl))
    .execute(db)
    .await?;
    Ok(r.rows_affected() == 1)
}

/// Lets a lease go (a simulation stopping cleanly): the next to ask takes the space at once, under
/// the next epoch. False if it wasn't this one's any more.
pub async fn release(db: &PgPool, lease: &Lease) -> sqlx::Result<bool> {
    let r = sqlx::query(
        "UPDATE space_leases SET sim = NULL, node = NULL, address = NULL, expires_at = now() \
         WHERE space = $1 AND part = $2 AND epoch = $3 AND sim = $4",
    )
    .bind(&lease.leased.space)
    .bind(lease.leased.part)
    .bind(lease.epoch)
    .bind(lease.sim)
    .execute(db)
    .await?;
    Ok(r.rows_affected() == 1)
}

fn owner_of(row: &sqlx::postgres::PgRow) -> sqlx::Result<Owner> {
    Ok(Owner {
        sim: row.try_get("sim")?,
        node: row.try_get("node")?,
        address: row.try_get("address")?,
        epoch: row.try_get("epoch")?,
        left: Duration::from_millis(row.try_get::<i64, _>("left_ms")?.max(0) as u64),
    })
}

/// Who holds `leased` now (a lease that hasn't run out), if anyone.
pub async fn owner(db: &PgPool, leased: &Leased) -> sqlx::Result<Option<Owner>> {
    let row = sqlx::query(
        "SELECT sim, node, address, epoch, (extract(epoch FROM expires_at - now()) * 1000)::bigint AS left_ms \
         FROM space_leases WHERE space = $1 AND part = $2 AND sim IS NOT NULL AND expires_at > now()",
    )
    .bind(&leased.space)
    .bind(leased.part)
    .fetch_optional(db)
    .await?;
    row.as_ref().map(owner_of).transpose()
}

/// Every space held now and who holds it, by space (a gate's routes; the directory's page).
pub async fn owners(db: &PgPool) -> sqlx::Result<Vec<(Leased, Owner)>> {
    let rows = sqlx::query(
        "SELECT space, part, sim, node, address, epoch, (extract(epoch FROM expires_at - now()) * 1000)::bigint AS left_ms \
         FROM space_leases WHERE sim IS NOT NULL AND expires_at > now() ORDER BY space, part",
    )
    .fetch_all(db)
    .await?;
    rows.iter().map(|r| Ok((Leased { space: r.try_get("space")?, part: r.try_get("part")? }, owner_of(r)?))).collect()
}

/// The fence every write about a space passes, inside the write's own transaction: Ok if `fence` is
/// the space's epoch now (and the lease isn't let go). The lease's row stays locked FOR SHARE until
/// the transaction ends, so no grant can come between this check and the write.
pub async fn check(tx: &mut PgConnection, fence: &Fence) -> sqlx::Result<Result<(), Stale>> {
    let now: Option<(i64, Option<i64>)> = sqlx::query_as("SELECT epoch, sim FROM space_leases WHERE space = $1 AND part = $2 FOR SHARE")
        .bind(&fence.leased.space)
        .bind(fence.leased.part)
        .fetch_optional(&mut *tx)
        .await?;
    Ok(match now {
        Some((epoch, Some(_))) if epoch == fence.epoch => Ok(()),
        Some((epoch, _)) => Err(Stale { fence: fence.clone(), now: Some(epoch) }),
        None => Err(Stale { fence: fence.clone(), now: None }),
    })
}

/// A space's snapshot: the epoch it was written under, its tick, and what its simulation wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub epoch: i64,
    pub tick: i64,
    pub data: Vec<u8>,
}

/// Writes a space's snapshot, fenced: `Err(Stale)` (and nothing written) once a newer grant has
/// been made.
pub async fn write_snapshot(db: &PgPool, fence: &Fence, tick: i64, data: &[u8]) -> sqlx::Result<Result<(), Stale>> {
    let mut tx = db.begin().await?;
    if let Err(stale) = check(&mut tx, fence).await? {
        return Ok(Err(stale));
    }
    sqlx::query(
        "INSERT INTO space_snapshots (space, part, epoch, tick, data) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (space, part) DO UPDATE SET epoch = EXCLUDED.epoch, tick = EXCLUDED.tick, data = EXCLUDED.data, saved_at = now()",
    )
    .bind(&fence.leased.space)
    .bind(fence.leased.part)
    .bind(fence.epoch)
    .bind(tick)
    .bind(data)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Ok(()))
}

/// The last snapshot written of a space, if any.
pub async fn read_snapshot(db: &PgPool, leased: &Leased) -> sqlx::Result<Option<Snapshot>> {
    let row: Option<(i64, i64, Vec<u8>)> = sqlx::query_as("SELECT epoch, tick, data FROM space_snapshots WHERE space = $1 AND part = $2")
        .bind(&leased.space)
        .bind(leased.part)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(epoch, tick, data)| Snapshot { epoch, tick, data }))
}
