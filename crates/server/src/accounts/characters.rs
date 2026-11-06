//! Characters: an account holds up to MAX_PER_ACCOUNT, each with its own island (kept on its row in
//! Postgres) and a name no other character on the server has, whatever the case, since names show
//! over heads. The browser's character select screen (src/ui/characterSelect.ts) lists them, makes
//! new ones and deletes them; the world plays whichever it picks (crates/server/src/play/socket.rs).
//!
//!   GET    /api/characters       yours, oldest first: {characters: [Character], max}
//!   POST   /api/characters       {name}: a new one with a fresh island -> {character}
//!   DELETE /api/characters/{id}  {name}: gone for good, island and all (its name typed to confirm)

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::types::Json as Jsonb;
use sqlx::{PgPool, Postgres, Transaction};

use crate::accounts::{Account, check_name, signed_in};
use crate::http::{ApiError, App, database};
use crate::life::content::quests;
use crate::skills::{allowed, build_from_saved, saved_by_id};
use crate::tuning::tuning;

/// Characters an account may hold.
pub const MAX_PER_ACCOUNT: i64 = 6;
const TOO_MANY: &str = "An account holds at most 6 characters. Delete one to make room.";

/// A character as the select screen shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: i64,
    pub name: String,
    /// The copy of Emberholm they live in (none until they first go in).
    pub channel: Option<i32>,
    /// When they last went into the world (ms since the epoch).
    pub last_played: Option<i64>,
    pub created: i64,
    /// What their skill tree may hold: the points everyone starts with and those their quests gave.
    pub skill_points: u32,
    pub quests_done: u32,
    pub coins: i64,
    /// The weapon of the build the world would give them, by id: the one kept, if their points
    /// cover it, or the starting one.
    pub weapon: String,
}

type Row = (i64, String, Option<i32>, Option<i64>, i64, Option<Jsonb<Value>>, Option<Jsonb<Value>>, Option<Jsonb<Value>>);

impl Character {
    fn from_row((id, name, channel, last_played, created, done, coins, build): Row) -> Self {
        let done: Vec<String> = done.and_then(|Jsonb(v)| serde_json::from_value(v).ok()).unwrap_or_default();
        let skill_points = skill_points(&done);
        let build = build.and_then(|Jsonb(v)| build_from_saved(&v)).filter(|b| allowed(b, skill_points)).unwrap_or_default();
        Character {
            id,
            name,
            channel,
            last_played,
            created,
            skill_points,
            quests_done: done.len() as u32,
            coins: coins.and_then(|Jsonb(v)| v.as_f64()).map_or(0, |c| c.floor() as i64),
            weapon: tuning().weapons.get(build.weapon as usize).map(|w| w.name.clone()).unwrap_or_default(),
        }
    }
}

/// Skill points for the quests in `done` (as crate::life::progress::skill_budget counts them, without
/// reading the whole island).
fn skill_points(done: &[String]) -> u32 {
    let earned: u32 = quests().iter().filter_map(|q| q.rewards.skill_points.filter(|&n| n != 0 && done.contains(&q.id))).sum();
    tuning().skills.start_points + earned
}

/// An account's characters, oldest first.
pub async fn of_account(db: &PgPool, account: i64) -> Result<Vec<Character>, sqlx::Error> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, name, home_channel, (extract(epoch FROM last_played_at) * 1000)::bigint, \
           (extract(epoch FROM created_at) * 1000)::bigint, island->'state'->'quests'->'done', \
           island->'state'->'coins', build \
         FROM characters WHERE account_id = $1 ORDER BY id",
    )
    .bind(account)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Character::from_row).collect())
}

/// Rewrites the builds still kept by index, as they were before builds named things by id, by id
/// (crate::skills::saved_by_id): how many it rewrote, and how many it left as they were. Run as the
/// server starts (crate::db::connect). A row is rewritten only if it still holds what was read, so
/// a build written meanwhile (by the server an update is replacing, say) is never lost: that one is
/// rewritten the next time a server starts, and read as it is until then
/// (crate::skills::build_from_saved reads both). One that was never a build the server would take
/// is left as it is, and the world still gives its character the starting build.
pub async fn keep_builds_by_id(db: &PgPool) -> Result<(u64, u64), sqlx::Error> {
    let rows: Vec<(i64, Jsonb<Value>)> =
        sqlx::query_as("SELECT id, build FROM characters WHERE jsonb_typeof(build->'weapon') = 'number'").fetch_all(db).await?;
    let (mut rewritten, mut left) = (0, 0);
    for (id, Jsonb(old)) in rows {
        let Some(by_id) = saved_by_id(&old) else {
            left += 1;
            continue;
        };
        let done =
            sqlx::query("UPDATE characters SET build = $2 WHERE id = $1 AND build = $3").bind(id).bind(Jsonb(by_id)).bind(Jsonb(old)).execute(db).await?;
        rewritten += done.rows_affected();
    }
    Ok((rewritten, left))
}

/// Adds a character with a fresh island. None if the name is taken, whatever the case.
pub async fn insert(tx: &mut Transaction<'_, Postgres>, account: i64, name: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("INSERT INTO characters (account_id, name) VALUES ($1, $2) ON CONFLICT ((lower(name))) DO NOTHING RETURNING id")
        .bind(account)
        .bind(name)
        .fetch_optional(&mut **tx)
        .await
}

/// The character a world connection plays: the one asked for if it's the account's, or with none
/// asked for, the one played last. None if there's no such character.
pub async fn pick(db: &PgPool, account: i64, asked: Option<i64>) -> Result<Option<(i64, String)>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, name FROM characters WHERE account_id = $1 AND ($2::bigint IS NULL OR id = $2) \
         ORDER BY last_played_at DESC NULLS LAST, id LIMIT 1",
    )
    .bind(account)
    .bind(asked)
    .fetch_optional(db)
    .await
}

async fn signed_in_account<'a>(app: &'a App, headers: &HeaderMap) -> Result<(&'a PgPool, Account), ApiError> {
    let db = database(app)?;
    let account = signed_in(headers, db).await?.ok_or(ApiError(StatusCode::UNAUTHORIZED, "Sign in first."))?;
    Ok((db, account))
}

pub async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let (db, account) = signed_in_account(&app, &headers).await?;
    let characters = of_account(db, account.id).await?;
    Ok(Json(json!({ "characters": characters, "max": MAX_PER_ACCOUNT })))
}

#[derive(Deserialize)]
pub struct Named {
    name: String,
}

pub async fn create(State(app): State<App>, headers: HeaderMap, Json(c): Json<Named>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (db, account) = signed_in_account(&app, &headers).await?;
    let name = c.name.trim();
    check_name(name)?;
    let mut tx = db.begin().await?;
    // One at a time per account, so two quick clicks can't go over the limit.
    sqlx::query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE").bind(account.id).execute(&mut *tx).await?;
    let held: i64 = sqlx::query_scalar("SELECT count(*) FROM characters WHERE account_id = $1").bind(account.id).fetch_one(&mut *tx).await?;
    if held >= MAX_PER_ACCOUNT {
        return Err(ApiError(StatusCode::CONFLICT, TOO_MANY));
    }
    let id = insert(&mut tx, account.id, name).await?.ok_or(ApiError(StatusCode::CONFLICT, "That name is taken."))?;
    tx.commit().await?;
    let made = of_account(db, account.id).await?.into_iter().find(|ch| ch.id == id);
    let made = made.ok_or(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "The character was made, but couldn't be read back. Try again in a moment."))?;
    Ok((StatusCode::CREATED, Json(json!({ "character": made }))))
}

pub async fn delete(State(app): State<App>, headers: HeaderMap, Path(id): Path<i64>, Json(d): Json<Named>) -> Result<Json<Value>, ApiError> {
    let (db, account) = signed_in_account(&app, &headers).await?;
    let row: Option<(String, Option<i32>)> =
        sqlx::query_as("SELECT name, home_channel FROM characters WHERE id = $1 AND account_id = $2").bind(id).bind(account.id).fetch_optional(db).await?;
    let Some((name, channel)) = row else {
        return Err(ApiError(StatusCode::NOT_FOUND, "You have no such character."));
    };
    if !d.name.trim().eq_ignore_ascii_case(&name) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Type the character's name to delete them."));
    }
    if app.world.is_playing(id) {
        return Err(ApiError(StatusCode::CONFLICT, "That character is in the world right now. Leave the world with them first."));
    }
    sqlx::query("DELETE FROM characters WHERE id = $1 AND account_id = $2").bind(id).bind(account.id).execute(db).await?;
    // Their houses and farms come down, and their plots are free for the next one.
    if let Some(channel) = channel {
        app.world.remove_resident(channel, id);
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(done: Option<Value>, coins: Option<Value>, build: Option<Value>) -> Row {
        (7, "Wren".into(), Some(2), Some(1_700_000_000_000), 1_600_000_000_000, done.map(Jsonb), coins.map(Jsonb), build.map(Jsonb))
    }

    /// The weapon the starting build holds.
    fn starting_weapon() -> String {
        tuning().weapons[crate::player::Build::default().weapon as usize].name.clone()
    }

    #[test]
    fn a_new_character_has_the_starting_points_and_a_sword() {
        let c = Character::from_row(row(None, None, None));
        assert_eq!(c.skill_points, tuning().skills.start_points);
        assert_eq!((c.quests_done, c.coins, c.weapon.as_str()), (0, 0, "sword"));
        assert_eq!(c.weapon, starting_weapon());
        assert_eq!(c.channel, Some(2));
    }

    #[test]
    fn finished_quests_count_their_skill_points() {
        let with_points: Vec<&str> = quests().iter().filter(|q| q.rewards.skill_points.unwrap_or(0) > 0).map(|q| q.id.as_str()).take(2).collect();
        assert!(!with_points.is_empty(), "some quest gives skill points");
        let want: u32 = tuning().skills.start_points
            + with_points.iter().map(|id| quests().iter().find(|q| q.id == *id).and_then(|q| q.rewards.skill_points).unwrap_or(0)).sum::<u32>();
        let bow = json!({ "weapon": "bow", "skills": ["bow"], "abilities": [], "movement": [] });
        let c = Character::from_row(row(Some(json!(with_points)), Some(json!(1234.0)), Some(bow)));
        assert_eq!(c.skill_points, want);
        assert_eq!(c.quests_done, with_points.len() as u32);
        assert_eq!((c.coins, c.weapon.as_str()), (1234, "bow"));
    }

    #[test]
    fn the_weapon_is_the_kept_builds_whichever_way_it_was_kept() {
        // As today's server keeps it, and as the server kept it before (Bow Training, the bow at
        // index 3 and node 9 of the order then).
        let by_id = json!({ "weapon": "bow", "skills": ["bow"], "abilities": [null], "movement": [null, null] });
        let by_index =
            json!({ "skills": [512, 0, 0, 0, 0, 0, 0, 0], "weapon": 3, "movement": [255, 255], "abilities": [255, 255, 255, 255, 255, 255, 255, 255] });
        for kept in [by_id, by_index] {
            assert_eq!(Character::from_row(row(None, None, Some(kept))).weapon, "bow");
        }
        // More than their points cover, the world gives them the starting build, and so does this.
        let greedy = json!({ "weapon": "bow", "skills": ["bow", "rapidFire", "piercing"], "abilities": [], "movement": [] });
        assert!(allowed(&build_from_saved(&greedy).unwrap(), 3) && !allowed(&build_from_saved(&greedy).unwrap(), tuning().skills.start_points));
        assert_eq!(Character::from_row(row(None, None, Some(greedy))).weapon, starting_weapon());
    }

    #[test]
    fn a_strange_island_reads_as_a_fresh_one() {
        let c = Character::from_row(row(Some(json!("nonsense")), Some(json!("lots")), Some(json!({ "weapon": 900, "skills": [1] }))));
        assert_eq!((c.quests_done, c.coins, c.weapon), (0, 0, starting_weapon()));
    }

    #[test]
    fn the_limit_is_what_the_refusal_says() {
        assert!(TOO_MANY.contains(&MAX_PER_ACCOUNT.to_string()));
    }

    #[test]
    fn the_select_screen_reads_camel_case() {
        let v = serde_json::to_value(Character::from_row(row(None, None, None))).unwrap();
        for key in ["id", "name", "channel", "lastPlayed", "created", "skillPoints", "questsDone", "coins", "weapon"] {
            assert!(v.get(key).is_some(), "{key}");
        }
    }
}
