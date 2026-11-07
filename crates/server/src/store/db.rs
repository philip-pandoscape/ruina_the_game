//! Postgres: the connection pool, the schema (crates/server/migrations/, applied on start, then the
//! saves from before land had rows moved into them: crate::store::land::migrate) and housekeeping.

use std::time::Duration;

use sqlx::postgres::{PgPool, PgPoolOptions};

/// Connects and brings the schema up to date. Docker Compose and Railway can both start the
/// server before the database takes connections, so this keeps trying for a minute first.
pub async fn connect(url: &str) -> Result<PgPool, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut wait = Duration::from_millis(500);
    let pool = loop {
        match PgPoolOptions::new().max_connections(16).acquire_timeout(Duration::from_secs(10)).connect(url).await {
            Ok(pool) => break pool,
            Err(e) if tokio::time::Instant::now() < deadline => {
                eprintln!("database not ready yet ({e}); trying again");
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(5));
            }
            Err(e) => return Err(format!("could not connect to the database: {e}")),
        }
    };
    sqlx::migrate!("./migrations").run(&pool).await.map_err(|e| format!("could not update the database schema: {e}"))?;
    // Builds kept by index, as they were before they named things by id (R9.1). Those left are read
    // as they are, so the game can go on without this.
    match crate::accounts::characters::keep_builds_by_id(&pool).await {
        Ok((0, 0)) => {}
        Ok((n, left)) => eprintln!("kept {n} builds by id; {left} kept by index weren't builds, and stay as they were"),
        Err(e) => eprintln!("could not keep the builds by id: {e}"),
    }
    // Saves from before land had rows of its own, moved into them (R10.21), before anyone plays.
    // Those left (changed meanwhile, or unreadable) are moved the next time, and played as they are.
    match super::land::migrate::run(&pool).await {
        Ok(r) if r.characters == 0 && r.left == 0 => {}
        Ok(r) => eprintln!(
            "moved {} saves' land into rows ({} pieces, {} plots claimed; {} houses moved to a free plot, {} taken down); {} left as they were",
            r.characters,
            r.pieces,
            r.plots,
            r.moved.len(),
            r.taken_down.len(),
            r.left
        ),
        Err(e) => eprintln!("could not move saves' land into rows: {e}"),
    }
    Ok(pool)
}

/// Clears out expired sign-ins now and then.
pub fn spawn_housekeeping(db: PgPool) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(3600));
        loop {
            every.tick().await;
            if let Err(e) = sqlx::query("DELETE FROM sessions WHERE expires_at < now()").execute(&db).await {
                eprintln!("could not clear expired sessions: {e}");
            }
        }
    });
}
