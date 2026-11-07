//! The processes playing the world (`nodes`, migration 0030): each writes its row when it starts
//! (its id, role, where its links take messages, and which start of it this is) and touches it
//! every couple of seconds. Processes find each other here: a gate the sims, the sims the services.
//! A row long untouched is a process gone; the services' sweep forgets it.

use std::time::Duration;

use sqlx::{PgPool, Row};

/// How often a process says it's still there.
pub const HEARTBEAT: Duration = Duration::from_secs(2);
/// A process not heard from for this long is taken for gone.
pub const GONE_AFTER: Duration = Duration::from_secs(10);

/// A process as the directory knows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeRow {
    pub id: String,
    pub role: String,
    pub address: String,
    pub incarnation: i64,
    /// Since it last said it was there.
    pub quiet: Duration,
}

/// A process says it has started (a new start of one with the same id takes its row over).
pub async fn register(db: &PgPool, id: &str, role: &str, address: &str, incarnation: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO nodes (id, role, address, incarnation) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, address = EXCLUDED.address, incarnation = EXCLUDED.incarnation, \
           started_at = now(), seen_at = now()",
    )
    .bind(id)
    .bind(role)
    .bind(address)
    .bind(incarnation)
    .execute(db)
    .await?;
    Ok(())
}

/// A process says it's still there. False if its row has been taken over by another start of the
/// same id (two processes given one id: the later one has it).
pub async fn heartbeat(db: &PgPool, id: &str, incarnation: i64) -> sqlx::Result<bool> {
    let r = sqlx::query("UPDATE nodes SET seen_at = now() WHERE id = $1 AND incarnation = $2").bind(id).bind(incarnation).execute(db).await?;
    Ok(r.rows_affected() == 1)
}

/// A process stopping cleanly goes from the list.
pub async fn leave(db: &PgPool, id: &str, incarnation: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM nodes WHERE id = $1 AND incarnation = $2").bind(id).bind(incarnation).execute(db).await?;
    Ok(())
}

/// The processes heard from within `within`, by id; of one role if given.
pub async fn alive(db: &PgPool, role: Option<&str>, within: Duration) -> sqlx::Result<Vec<NodeRow>> {
    let rows = sqlx::query(
        "SELECT id, role, address, incarnation, (extract(epoch FROM now() - seen_at) * 1000)::bigint AS quiet_ms FROM nodes \
         WHERE seen_at > now() - $1 * interval '1 millisecond' AND ($2::text IS NULL OR role = $2) ORDER BY id",
    )
    .bind(within.as_millis() as i64)
    .bind(role)
    .fetch_all(db)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(NodeRow {
                id: r.try_get("id")?,
                role: r.try_get("role")?,
                address: r.try_get("address")?,
                incarnation: r.try_get("incarnation")?,
                quiet: Duration::from_millis(r.try_get::<i64, _>("quiet_ms")?.max(0) as u64),
            })
        })
        .collect()
}

/// Forgets processes not heard from for `older_than`. How many.
pub async fn sweep(db: &PgPool, older_than: Duration) -> sqlx::Result<u64> {
    let r = sqlx::query("DELETE FROM nodes WHERE seen_at < now() - $1 * interval '1 millisecond'").bind(older_than.as_millis() as i64).execute(db).await?;
    Ok(r.rows_affected())
}

/// Says this process is still there every `HEARTBEAT` until it stops (or another start of it takes
/// its row, which it says on stderr).
pub fn spawn_heartbeat(db: PgPool, id: String, incarnation: i64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(HEARTBEAT);
        loop {
            every.tick().await;
            match heartbeat(&db, &id, incarnation).await {
                Ok(true) => {}
                Ok(false) => {
                    eprintln!("node {id}: another start of this node has taken its place in the directory");
                    return;
                }
                Err(e) => eprintln!("node {id}: couldn't reach the directory ({e}); trying again"),
            }
        }
    })
}
