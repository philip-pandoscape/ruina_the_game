//! A character's grant, kept on their row: the epoch every write about them carries
//! (`characters.epoch`, bumped by each claim and each move to another simulation, so whatever had
//! them before can't write any more), the session holding them (`live_session`) and where their
//! saved position is (`space`). And the copies' numbers. Which channel someone plays in is the
//! directory's, by the channels' policy (crates/channels), not kept on their row.

use ruina_world_api::{CharacterId, Epoch, SessionId, SpaceId};
use sqlx::Row;

use crate::store::Db;

/// What a claim found: the new epoch, and where the saved position is.
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub epoch: Epoch,
    pub space: Option<SpaceId>,
}

/// Grants a character to `session`: their epoch bumped, and when they last played.
pub async fn claim(db: &Db, character: CharacterId, session: SessionId) -> Result<Claim, String> {
    match db {
        Db::Pg(pool) => {
            let row = sqlx::query("UPDATE characters SET epoch = epoch + 1, live_session = $2, last_played_at = now() WHERE id = $1 RETURNING epoch, space")
                .bind(character)
                .bind(session)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("no such character")?;
            let epoch: i64 = row.get(0);
            let space: Option<String> = row.get(1);
            Ok(Claim { epoch: Epoch(epoch as u64), space: space.and_then(|s| s.parse().ok()) })
        }
        Db::Memory(t) => {
            let mut t = Db::tables(t);
            let c = t.characters.get_mut(&character).ok_or("no such character")?;
            c.epoch += 1;
            c.live_session = Some(session);
            Ok(Claim { epoch: Epoch(c.epoch), space: c.space.as_deref().and_then(|s| s.parse().ok()) })
        }
    }
}

/// Grants a character to another simulation: their epoch bumped, so what had them can't write.
pub async fn bump(db: &Db, character: CharacterId) -> Result<Epoch, String> {
    match db {
        Db::Pg(pool) => {
            let epoch: i64 = sqlx::query_scalar("UPDATE characters SET epoch = epoch + 1 WHERE id = $1 RETURNING epoch")
                .bind(character)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("no such character")?;
            Ok(Epoch(epoch as u64))
        }
        Db::Memory(t) => {
            let mut t = Db::tables(t);
            let c = t.characters.get_mut(&character).ok_or("no such character")?;
            c.epoch += 1;
            Ok(Epoch(c.epoch))
        }
    }
}

/// A new copy's number, never used before on this world.
pub async fn next_copy(db: &Db) -> Result<u64, String> {
    match db {
        Db::Pg(pool) => {
            let n: i64 = sqlx::query_scalar("SELECT nextval('copy_numbers')").fetch_one(pool).await.map_err(|e| e.to_string())?;
            Ok(n as u64)
        }
        Db::Memory(t) => {
            let mut t = Db::tables(t);
            t.copy_numbers += 1;
            Ok(t.copy_numbers)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn each_claim_and_each_move_is_a_newer_grant() {
        let (db, t) = Db::memory();
        Db::tables(&t).add_character(1, "P1");
        let first = claim(&db, 1, 100).await.unwrap();
        assert_eq!(first.epoch, Epoch(1));
        assert_eq!(bump(&db, 1).await.unwrap(), Epoch(2));
        let again = claim(&db, 1, 101).await.unwrap();
        assert_eq!(again.epoch, Epoch(3), "a newer grant");
        assert_eq!(Db::tables(&t).characters[&1].live_session, Some(101));
        assert!(claim(&db, 999, 0).await.is_err());
        assert_eq!((next_copy(&db).await, next_copy(&db).await), (Ok(1), Ok(2)));
    }

    /// The same against Postgres, where RUINA_TEST_DATABASE_URL names one (the private rig's): the
    /// grant bumps characters.epoch, and the store's fenced write takes the newest grant only.
    #[tokio::test]
    async fn postgres_refuses_a_write_under_an_older_grant() {
        let Ok(url) = std::env::var("RUINA_TEST_DATABASE_URL") else {
            eprintln!("skipped: RUINA_TEST_DATABASE_URL names no database");
            return;
        };
        let pool = crate::store::db::connect(&url).await.expect("the database");
        let name = format!("fence{}", crate::store::now_ms() % 1_000_000_000);
        let account: i64 = sqlx::query_scalar("INSERT INTO accounts (username, username_key, password_hash) VALUES ($1, $2, 'x') RETURNING id")
            .bind(&name)
            .bind(name.to_lowercase())
            .fetch_one(&pool)
            .await
            .unwrap();
        let character: i64 = sqlx::query_scalar("INSERT INTO characters (account_id, name) VALUES ($1, $2) RETURNING id")
            .bind(account)
            .bind(&name)
            .fetch_one(&pool)
            .await
            .unwrap();
        let db = Db::Pg(pool.clone());
        let first = claim(&db, character, 1).await.unwrap();
        let moved = bump(&db, character).await.unwrap();
        assert_eq!(moved, first.epoch.next());
        let write = |epoch: Epoch, coins: f64| ruina_world_api::store::LifeWrite {
            character,
            epoch,
            life: serde_json::json!({ "state": { "coins": coins }, "player": {} }),
            space: SpaceId::channel("emberholm", 1),
            writer: None,
            tell: None,
        };
        // Under the newest grant: written. Under the one before: refused, the newer kept.
        assert_eq!(db.write_lives(&[write(moved, 5.0)]).await, Ok(vec![true]));
        assert_eq!(db.write_lives(&[write(first.epoch, 9.0)]).await, Ok(vec![false]));
        // In one transaction, a stale one among them is refused alone.
        assert_eq!(db.write_lives(&[write(moved, 6.0), write(first.epoch, 9.0)]).await, Ok(vec![true, false]));
        let saved = db.load_life(character).await.unwrap().life.unwrap();
        assert_eq!(saved["state"]["coins"], 6.0);
        let space: Option<String> = sqlx::query_scalar("SELECT space FROM characters WHERE id = $1").bind(character).fetch_one(&pool).await.unwrap();
        assert_eq!(space.as_deref(), Some("channel:emberholm:1"));
        sqlx::query("DELETE FROM accounts WHERE id = $1").bind(account).execute(&pool).await.unwrap();
    }
}
