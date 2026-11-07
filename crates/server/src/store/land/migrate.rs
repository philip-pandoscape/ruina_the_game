//! Saves from before land had rows of its own, moved into them (R10.21). A character's save kept
//! everything in one document: their life, and inside it (version 3 and before) or beside it (the
//! first half of this work: `{state, land, player}`) everything of theirs that stood in the world.
//! Moved, the save is the life alone (`{state, player}`, version 4, no `land`), each piece of land is
//! a row of its own with an id from the world's blocks, and each house's plot is claimed in the
//! world's registry. Run as the server starts, before anyone plays (`run`), like the builds' move
//! to ids (crate::accounts::characters::keep_builds_by_id): a save is moved only if it still holds
//! what was read, each in one transaction, so a save written meanwhile is moved the next time.
//!
//! - **Times.** A save that kept its land inside its life kept the land's times (tax paid until, an
//!   animal fed until, a pack made at) on the life's clock; they're moved onto the world's from the
//!   moment it was saved (`Land::rebase`), so what was left of each is left of it still.
//! - **Plots.** Each channel had its own eight plots, so two characters in two channels may both
//!   have built on one. Now a plot is claimed once in the world: the first character to have been
//!   made (the lowest id, as each channel decided it) keeps it, and anyone else's house on it is
//!   moved, whole, to the first plot nobody holds. With none free, it's taken down and what it held
//!   (its chest, and the blueprint that built it) goes into its owner's bag, as much as fits; the
//!   rest is named in the log, and in what `run` reports.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::types::Json;

use super::{BLOCK, WORLD, write_holding};
use crate::life::content::items;
use crate::life::land::{self, House, Land};
use crate::life::state::{LIFE_VERSION, LifeState};
use crate::life::{Life, housing};
use crate::open::map::world_map;
use crate::open::zone::emberholm;

/// A save moved: the life as it's kept from now on (`{state, player}`), and its land (with the ids
/// it had, its times on the world's clock).
#[derive(Clone, Debug, PartialEq)]
pub struct Moved {
    pub life: Value,
    pub land: Land,
}

/// Reads a save in either older shape. None if it's moved already (version 4 or later, no `land`
/// beside it: its land is in rows). `saved_at` is when it was saved (ms since 1970).
pub fn read(island: &Value, saved_at: Option<i64>) -> Result<Option<Moved>, String> {
    let version = island.get("state").and_then(|s| s.get("version")).and_then(Value::as_i64).unwrap_or(0);
    if version >= LIFE_VERSION && land::kept_inside(island) {
        return Ok(None);
    }
    let (mut state, mut land) = land::read_saved(island)?;
    if land::kept_inside(island)
        && let Some(at) = saved_at
    {
        land.rebase(at as f64 / 1000.0 - state.clock);
    }
    state.version = LIFE_VERSION;
    let life = json!({ "state": state, "player": island.get("player").cloned().unwrap_or(Value::Null) });
    Ok(Some(Moved { life, land }))
}

/// Gives every piece of `land` a new id from `next`, keeping what names one piece from another (a
/// pack's vehicle, a vehicle's cargo). The old id to the new.
pub fn rekey(land: &mut Land, mut next: impl FnMut() -> i64) -> BTreeMap<(&'static str, i64), i64> {
    let mut map = BTreeMap::new();
    for h in &mut land.houses {
        let id = next();
        map.insert(("house", h.id), id);
        h.id = id;
    }
    for s in &mut land.scarecrows {
        let id = next();
        map.insert(("farm", s.id), id);
        s.id = id;
    }
    for s in &mut land.ships {
        let id = next();
        map.insert(("ship", s.id), id);
        s.id = id;
    }
    for v in &mut land.vehicles {
        let id = next();
        map.insert(("vehicle", v.id), id);
        v.id = id;
    }
    for p in &mut land.packs {
        let id = next();
        map.insert(("pack", p.id), id);
        p.id = id;
    }
    for p in &mut land.packs {
        if p.vehicle != 0 {
            p.vehicle = map.get(&("vehicle", p.vehicle)).copied().unwrap_or(0);
        }
    }
    for v in &mut land.vehicles {
        for c in &mut v.cargo {
            if *c != 0 {
                *c = map.get(&("pack", *c)).copied().unwrap_or(0);
            }
        }
    }
    map
}

/// What a house held, back in its owner's bag: its chest, and the item that claimed its plot. What
/// didn't fit.
pub fn take_down(state: &mut LifeState, h: &House) -> Vec<(String, i64)> {
    let mut life = Life::new(emberholm(), None, None);
    life.state = std::mem::take(state);
    let mut left = Vec::new();
    let deed = items().iter().find(|it| it.places.as_deref() == Some(h.blueprint.as_str()) && it.place_on.as_deref() == Some("plot"));
    let back = h.storage.iter().map(|s| (s.item.clone(), s.n)).chain(deed.map(|d| (d.id.clone(), 1)));
    for (item, n) in back {
        let over = life.give(&item, n, true);
        if over > 0 {
            left.push((item, over));
        }
    }
    life.drain_events();
    *state = std::mem::take(&mut life.state);
    left
}

/// A house taken down in the move for want of a free plot: whose, the plot it stood on, and what
/// of it didn't fit back in their bag (item, how many).
pub type TakenDown = (i64, String, Vec<(String, i64)>);

/// What the move did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    /// Saves moved.
    pub characters: u64,
    /// Pieces of land given rows.
    pub pieces: u64,
    /// Plots claimed in the world's registry.
    pub plots: u64,
    /// Houses moved to another plot, someone else's claim on theirs being earlier: (character, from, to).
    pub moved: Vec<(i64, String, String)>,
    /// Houses taken down for want of a free plot: (character, plot, what didn't fit in the bag).
    pub taken_down: Vec<TakenDown>,
    /// Saves left as they were: changed while being moved (moved next time), or unreadable.
    pub left: u64,
}

/// Moves every save still holding its land into rows. The plots are worked out first, for everyone
/// at once: each goes to the first-made character with a house on it (or stays with whoever the
/// registry already has, after a start that moved some), and then each other house on one is given
/// the first plot nobody holds, in the order its owner was made. Then each save is moved in a
/// transaction of its own.
pub async fn run(db: &PgPool) -> Result<Report, sqlx::Error> {
    let rows: Vec<(i64, Json<Value>, Option<i64>)> = sqlx::query_as(
        "SELECT id, island, (extract(epoch FROM saved_at) * 1000)::bigint FROM characters \
         WHERE island IS NOT NULL AND (island ? 'land' OR COALESCE((island->'state'->>'version')::int, 0) < $1) ORDER BY id",
    )
    .bind(LIFE_VERSION as i32)
    .fetch_all(db)
    .await?;
    let mut report = Report::default();
    let mut saves: Vec<(i64, Value, Moved)> = Vec::new();
    for (character, Json(old), saved_at) in rows {
        match read(&old, saved_at) {
            Ok(Some(m)) => saves.push((character, old, m)),
            Ok(None) => {}
            Err(e) => {
                eprintln!("character {character}: the save can't be read ({e}), so its land stays in it");
                report.left += 1;
            }
        }
    }
    // Who holds each plot: the registry's claims stand; then the first-made with a house on it.
    let mut held: BTreeMap<String, i64> =
        sqlx::query_as::<_, (String, i64)>("SELECT plot, holder FROM plots WHERE world = $1").bind(WORLD).fetch_all(db).await?.into_iter().collect();
    for (character, _, m) in &saves {
        for h in &m.land.houses {
            held.entry(h.plot.clone()).or_insert(*character);
        }
    }
    let all_plots: Vec<String> = world_map().recipes().flat_map(|r| &r.house_plots).map(|p| p.id.clone()).collect();
    for (character, _, m) in &mut saves {
        let mut state: LifeState = serde_json::from_value(m.life["state"].clone()).unwrap_or_default();
        let mut kept: Vec<House> = Vec::new();
        for mut h in std::mem::take(&mut m.land.houses) {
            if held.get(&h.plot) == Some(character) && !kept.iter().any(|k| k.plot == h.plot) {
                kept.push(h);
                continue;
            }
            match all_plots.iter().find(|p| !held.contains_key(*p) && housing::plot_def(p).is_some()).cloned() {
                Some(to) => {
                    eprintln!("character {character}: their house on {} stood where an earlier claim did; it's moved, whole, to {to}", h.plot);
                    report.moved.push((*character, h.plot.clone(), to.clone()));
                    held.insert(to.clone(), *character);
                    h.plot = to;
                    kept.push(h);
                }
                None => {
                    let lost = take_down(&mut state, &h);
                    eprintln!(
                        "character {character}: no plot is free for their house on {}: it's taken down, its chest and blueprint back in their bag (not fitting: {lost:?})",
                        h.plot
                    );
                    report.taken_down.push((*character, h.plot.clone(), lost));
                }
            }
        }
        m.land.houses = kept;
        m.life["state"] = serde_json::to_value(&state).unwrap_or(Value::Null);
    }
    for (character, old, mut moved) in saves {
        let mut tx = db.begin().await?;
        // Ids from the world's blocks: one is plenty for a character's land.
        let pieces =
            (moved.land.houses.len() + moved.land.scarecrows.len() + moved.land.ships.len() + moved.land.packs.len() + moved.land.vehicles.len()) as i64;
        let mut blocks: Vec<i64> = Vec::new();
        while (blocks.len() as i64) * BLOCK < pieces {
            blocks.push(sqlx::query_scalar("SELECT nextval('land_blocks')").fetch_one(&mut *tx).await?);
        }
        let mut ids = blocks.iter().flat_map(|b| b * BLOCK..(b + 1) * BLOCK);
        rekey(&mut moved.land, || ids.next().unwrap_or(0));
        let done = sqlx::query("UPDATE characters SET island = $2 WHERE id = $1 AND island = $3")
            .bind(character)
            .bind(Json(&moved.life))
            .bind(Json(&old))
            .execute(&mut *tx)
            .await?;
        if done.rows_affected() != 1 {
            // Written meanwhile: the next start moves it.
            tx.rollback().await?;
            report.left += 1;
            continue;
        }
        write_holding(&mut tx, character, 0, &moved.land).await?;
        let mut claimed = 0;
        for h in &moved.land.houses {
            let got: Option<i64> = sqlx::query_scalar(
                "INSERT INTO plots (world, plot, holder, house) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (world, plot) DO UPDATE SET house = EXCLUDED.house WHERE plots.holder = EXCLUDED.holder RETURNING holder",
            )
            .bind(WORLD)
            .bind(&h.plot)
            .bind(character)
            .bind(h.id)
            .fetch_optional(&mut *tx)
            .await?;
            if got.is_none() {
                break;
            }
            claimed += 1;
        }
        if claimed != moved.land.houses.len() {
            // Claimed by someone between the look and now (a server playing already): the next start
            // moves this one.
            tx.rollback().await?;
            report.left += 1;
            continue;
        }
        tx.commit().await?;
        report.characters += 1;
        report.pieces += pieces as u64;
        report.plots += claimed as u64;
    }
    Ok(report)
}
