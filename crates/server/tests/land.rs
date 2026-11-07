//! The store's land against a real Postgres (crates/server/src/store/land/): given `RUINA_TEST_DATABASE_URL`
//! (one it may make databases in, such as a test rig's: docs/testing.md), each test makes a database
//! of its own, named after it, and runs the server's migrations on it. Without one, they say so and
//! pass.

use std::collections::BTreeMap;

use ruina_server::life::housing::{DAY, demolish_neglected, demolished_at};
use ruina_server::life::land::{House, Land, Pack, Scarecrow, Vehicle};
use ruina_server::life::state::LifeState;
use ruina_server::store::land::ledger::{self, Applied, pot, transfer};
use ruina_server::store::land::migrate::{self, read, rekey};
use ruina_server::store::land::plots::{Claim, claim, claims, holder, houses, take_down};
use ruina_server::store::land::{BLOCK, Fence, LifeSave, load_holding, load_land, market, reserve_ids, save};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::types::Json;

/// A database of the test's own, the server's migrations run on it. None (and a note) without one.
async fn fresh(name: &str) -> Option<PgPool> {
    let Ok(url) = std::env::var("RUINA_TEST_DATABASE_URL") else {
        eprintln!("{name}: RUINA_TEST_DATABASE_URL isn't set, so this test of the store has nothing to run on");
        return None;
    };
    let db = format!("land_test_{name}");
    let admin = PgPool::connect(&url).await.expect("the test database");
    // The name is the test's own, made here: nothing from outside goes into it.
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"))).execute(&admin).await.expect("drop");
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {db}"))).execute(&admin).await.expect("create");
    admin.close().await;
    let (base, _) = url.rsplit_once('/').expect("a database url");
    Some(ruina_server::store::db::connect(&format!("{base}/{db}")).await.expect("migrated"))
}

/// A character of its own account, playing as session `id` (their life an empty one).
async fn character(db: &PgPool, name: &str) -> i64 {
    let account: i64 = sqlx::query_scalar("INSERT INTO accounts (username, username_key, password_hash) VALUES ($1, lower($1), 'x') RETURNING id")
        .bind(name)
        .fetch_one(db)
        .await
        .unwrap();
    let id: i64 =
        sqlx::query_scalar("INSERT INTO characters (account_id, name) VALUES ($1, $2) RETURNING id").bind(account).bind(name).fetch_one(db).await.unwrap();
    id
}

/// Their grant as they play (a new character's first: 0).
fn playing(character: i64) -> Fence {
    Fence::Epoch { character, epoch: 0 }
}

/// A grant they no longer hold: a window replaced, a simulation they've left.
fn replaced(character: i64) -> Fence {
    Fence::Epoch { character, epoch: -1 }
}

fn cottage(id: i64, plot: &str, tax_paid_until: f64) -> House {
    House { id, plot: plot.into(), blueprint: "cottage".into(), tax_paid_until, ..House::default() }
}

#[tokio::test]
async fn a_plot_is_claimed_once_even_when_two_channels_race_for_it() {
    let Some(db) = fresh("plot_race").await else { return };
    let (ada, bo) = (character(&db, "Ada").await, character(&db, "Bo").await);
    let mut ids = reserve_ids(&db).await.unwrap();
    // Every plot of the world, each claimed by both at the same moment, from two connections (two
    // channels' worth of servers): one claim each is kept, and the other finds whose it is.
    for k in 1..=8 {
        let plot = format!("rise-{k}");
        let (a, b) = (cottage(ids.next, &plot, 0.0), cottage(ids.next + 1, &plot, 0.0));
        ids.next += 2;
        let (ra, rb) = tokio::join!(claim(&db, &plot, ada, playing(ada), &a), claim(&db, &plot, bo, playing(bo), &b));
        let (ra, rb) = (ra.unwrap(), rb.unwrap());
        let won = [&ra, &rb].iter().filter(|r| ***r == Claim::Yours).count();
        assert_eq!(won, 1, "{plot}: {ra:?} and {rb:?}");
        let who = holder(&db, &plot).await.unwrap().expect("held");
        let (lost, winner_name) = if ra == Claim::Yours { (&rb, "Ada") } else { (&ra, "Bo") };
        assert_eq!(*lost, Claim::Theirs { holder: who, name: winner_name.into() });
        // The loser's house never reached the world: only the winner's is in it.
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM land WHERE data->>'plot' = $1").bind(&plot).fetch_one(&db).await.unwrap();
        assert_eq!(n, 1, "{plot}");
    }
    assert_eq!(claims(&db).await.unwrap().len(), 8);
    // Claiming your own plot again only brings its house up to date; a window replaced writes nothing.
    let mine = claims(&db).await.unwrap()["rise-1"].0;
    let again = cottage(sqlx::query_scalar("SELECT house FROM plots WHERE plot = 'rise-1'").fetch_one(&db).await.unwrap(), "rise-1", 5.0);
    assert_eq!(claim(&db, "rise-1", mine, playing(mine), &again).await.unwrap(), Claim::Yours);
    assert_eq!(claim(&db, "rise-1", mine, replaced(mine), &again).await.unwrap(), Claim::Stale);
}

#[tokio::test]
async fn a_transfer_sent_twice_is_applied_once() {
    let Some(db) = fresh("transfer_twice").await else { return };
    let (ann, bea) = (character(&db, "Ann").await, character(&db, "Bea").await);
    let life = |coins: f64| json!({ "state": { "version": 4, "coins": coins }, "player": { "x": 0.0, "y": 0.0, "z": 0.0, "facing": 0.0 } });
    let t = pot("pot:channel:emberholm:1:table:7", ann, bea, 50.0, "beacons");
    let saves = |a: f64, b: f64| {
        vec![
            LifeSave { character: ann, fence: playing(ann), life: life(a), land: None, space: None, lease: None },
            LifeSave { character: bea, fence: playing(bea), life: life(b), land: None, space: None, lease: None },
        ]
    };
    assert_eq!(transfer(&db, &t, &saves(250.0, 150.0)).await.unwrap(), Applied::Now(vec![true, true]));
    // Sent again (a retry, a message delivered twice), with the lives as they are by then: nothing more.
    assert_eq!(transfer(&db, &t, &saves(999.0, 0.0)).await.unwrap(), Applied::Already);
    let coins = |id: i64| {
        let db = db.clone();
        async move {
            sqlx::query_scalar::<_, f64>("SELECT (island->'state'->>'coins')::float8 FROM characters WHERE id = $1").bind(id).fetch_one(&db).await.unwrap()
        }
    };
    assert_eq!((coins(ann).await, coins(bea).await), (250.0, 150.0));
    let rows: Vec<(String, f64)> = sqlx::query_as("SELECT party, coins FROM ledger ORDER BY character").fetch_all(&db).await.unwrap();
    assert_eq!(rows, [(format!("character:{bea}"), 50.0), (format!("character:{ann}"), -50.0)]);
    // A life's own entries go in with its save, each once however often the save is written.
    let mut with = life(80.0);
    with["state"]["ledger"] = json!([
        { "n": 1, "kind": "purchase", "party": "vendor:mara", "coins": -12.0, "seals": 0.0, "items": [{ "item": "seed.sunroot", "n": 3 }] },
        { "n": 2, "kind": "payout", "party": "post:westwatch", "coins": 329.0, "seals": 1.0, "items": [], "detail": "harvestCrate" }
    ]);
    let s = [LifeSave { character: ann, fence: playing(ann), life: with, land: None, space: None, lease: None }];
    assert_eq!(save(&db, &s).await.unwrap(), [true]);
    assert_eq!(save(&db, &s).await.unwrap(), [true]);
    let kinds: Vec<(String, String, f64)> = ledger::of(&db, ann).await.unwrap().into_iter().map(|(k, kind, _, c, _)| (k, kind, c)).collect();
    assert_eq!(
        kinds,
        [
            (format!("pot:channel:emberholm:1:table:7:{ann}"), "pot".into(), 50.0),
            (format!("life:{ann}:1"), "purchase".into(), -12.0),
            (format!("life:{ann}:2"), "payout".into(), 329.0),
        ]
    );
}

#[tokio::test]
async fn land_is_kept_by_the_chunk_it_stands_in() {
    let Some(db) = fresh("land_by_chunk").await else { return };
    let ada = character(&db, "Ada").await;
    let ids = reserve_ids(&db).await.unwrap();
    assert!(ids.next >= BLOCK && ids.end - ids.next == BLOCK);
    let n = |k: i64| ids.next + k;
    let mut land = Land::default();
    land.vehicles.push(Vehicle { id: n(0), def: "farmCart".into(), x: 300.0, z: -10.0, cargo: vec![n(1), 0], ..Vehicle::default() });
    land.packs.push(Pack { id: n(1), def: "flaxBale".into(), at: "cargo".into(), vehicle: n(0), ..Pack::default() });
    land.packs.push(Pack { id: n(2), def: "flaxBale".into(), at: "ground".into(), x: -10.0, z: -300.0, ..Pack::default() });
    land.packs.push(Pack { id: n(3), def: "flaxBale".into(), at: "back".into(), ..Pack::default() });
    land.scarecrows.push(Scarecrow { id: n(4), x: -208.0, z: -240.0, cells: vec![None; 16], ..Scarecrow::default() });
    let life = json!({ "state": { "version": 4 }, "player": {} });
    assert_eq!(
        save(&db, &[LifeSave { character: ada, fence: playing(ada), life: life.clone(), land: Some(land.clone()), space: None, lease: None }]).await.unwrap(),
        [true]
    );
    // A region's keeper reads its chunks: the cart and what's in its bed east of the middle.
    let east = load_land(&db, Some(&[(1, -1)])).await.unwrap();
    assert_eq!(east[&ada].vehicles.len(), 1);
    assert_eq!(east[&ada].packs.iter().map(|p| p.id).collect::<Vec<_>>(), [n(1)]);
    let south = load_land(&db, Some(&[(-1, -2), (-1, -1)])).await.unwrap();
    assert_eq!((south[&ada].packs.len(), south[&ada].scarecrows.len()), (1, 1));
    // Everything of theirs comes back with them, the pack on their back too.
    let back = load_holding(&db, ada).await.unwrap();
    assert_eq!((back.vehicles, back.packs, back.scarecrows), (land.vehicles.clone(), land.packs.clone(), land.scarecrows.clone()));
    // Sold, used up, recalled: gone from the world when the life is next saved.
    land.packs.retain(|p| p.at != "ground");
    land.vehicles[0].x = -300.0;
    assert_eq!(
        save(&db, &[LifeSave { character: ada, fence: playing(ada), life: life.clone(), land: Some(land.clone()), space: None, lease: None }]).await.unwrap(),
        [true]
    );
    let rows: Vec<(i64, Option<i32>, Option<i32>)> = sqlx::query_as("SELECT id, cx, cz FROM land ORDER BY id").fetch_all(&db).await.unwrap();
    assert_eq!(rows, [(n(0), Some(-2), Some(-1)), (n(1), Some(-2), Some(-1)), (n(3), None, None), (n(4), Some(-1), Some(-1))]);
    // A window that has been replaced writes nothing.
    land.packs.clear();
    let stale = LifeSave { character: ada, fence: replaced(ada), life, land: Some(land), space: None, lease: None };
    assert_eq!(save(&db, &[stale]).await.unwrap(), [false]);
    assert_eq!(load_holding(&db, ada).await.unwrap().packs.len(), 2);
}

#[tokio::test]
async fn a_neglected_house_comes_down_and_its_plot_is_free_for_the_next_claim() {
    let Some(db) = fresh("neglect").await else { return };
    let (ada, bo) = (character(&db, "Ada").await, character(&db, "Bo").await);
    let ids = reserve_ids(&db).await.unwrap();
    let t0 = 1.76e9;
    let (old, fresh_one) = (cottage(ids.next, "rise-1", t0), cottage(ids.next + 1, "rise-2", t0 + 30.0 * DAY));
    assert_eq!(claim(&db, "rise-1", ada, playing(ada), &old).await.unwrap(), Claim::Yours);
    assert_eq!(claim(&db, "rise-2", bo, playing(bo), &fresh_one).await.unwrap(), Claim::Yours);
    // The region's keeper looks over the world's houses on the world's clock, with the engine's rule.
    let now = demolished_at(&old);
    let mut by_owner: BTreeMap<i64, Land> = BTreeMap::new();
    for (owner, h) in houses(&db).await.unwrap() {
        by_owner.entry(owner).or_default().houses.push(h);
    }
    let gone: Vec<i64> = by_owner.values_mut().flat_map(|land| demolish_neglected(land, now)).map(|h| h.id).collect();
    assert_eq!(gone, [old.id]);
    assert_eq!(take_down(&db, &gone, now, None).await.unwrap(), [("rise-1".to_string(), ada)]);
    assert_eq!(holder(&db, "rise-1").await.unwrap(), None);
    assert_eq!(holder(&db, "rise-2").await.unwrap(), Some(bo));
    // Free for anyone: Bo's alt claims it.
    let cy = character(&db, "Cy").await;
    assert_eq!(claim(&db, "rise-1", cy, playing(cy), &cottage(ids.next + 2, "rise-1", now + 7.0 * DAY)).await.unwrap(), Claim::Yours);
}

#[tokio::test]
async fn every_server_s_sales_lower_the_worlds_demand() {
    let Some(db) = fresh("market").await else { return };
    let d = ruina_server::life::content::demand();
    // Two sales at once, from two servers, at the same moment: both count.
    let (a, b) = tokio::join!(market::sold(&db, "westwatch", "harvestCrate", 1000.0), market::sold(&db, "westwatch", "harvestCrate", 1000.0));
    let (a, b) = (a.unwrap(), b.unwrap());
    let low = a.value.min(b.value);
    assert!((low - (d.start - 2.0 * d.drop_per_sale)).abs() < 1e-12, "{low}");
    // As the engine works it out: a minute on, a minute's worth back, then a sale.
    let m = market::load(&db).await.unwrap();
    let mut engine = m.clone();
    engine.sell("westwatch", "harvestCrate", 1060.0);
    let stored = market::sold(&db, "westwatch", "harvestCrate", 1060.0).await.unwrap();
    assert_eq!(stored.value, engine.demand["westwatch:harvestCrate"].value);
    assert_eq!(market::load(&db).await.unwrap(), engine);
}

/// Today's saves (written by the server at 763d6af, and made by its rules), as rows of characters.
fn fixtures() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/saves-763d6af.json")).expect("the fixtures")
}

fn saved_at_ms(row: &Value) -> Option<i64> {
    // RFC 3339 in UTC to ms since 1970, by days from the civil date (no clock crate in the server).
    let s = row["saved_at"].as_str()?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().unwrap_or(0));
    let (y, m, day) = (d.next()?, d.next()?, d.next()?);
    let t = time.trim_end_matches('Z');
    let mut parts = t.split(':');
    let (h, mi) = (parts.next()?.parse::<i64>().ok()?, parts.next()?.parse::<i64>().ok()?);
    let sec: f64 = parts.next()?.parse().ok()?;
    let (yy, mm) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000 + h * 3_600_000 + mi * 60_000 + (sec * 1000.0).round() as i64)
}

/// A piece's land with its ids out of the way, for comparing land before and after a move.
fn without_ids(land: &Land) -> Value {
    let mut l = land.clone();
    let mut map = BTreeMap::new();
    let mut n = 0;
    rekey(&mut l, || {
        n += 1;
        n
    })
    .into_iter()
    .for_each(|(k, v)| {
        map.insert(k, v);
    });
    let mut v = serde_json::to_value(&l).unwrap();
    for k in ["houses", "scarecrows", "ships", "packs", "vehicles"] {
        if let Some(list) = v[k].as_array_mut() {
            list.sort_by_key(|x| x["id"].as_i64());
        }
    }
    v
}

#[test]
fn todays_saves_are_read_as_a_life_and_its_land_on_the_worlds_clock() {
    for row in fixtures() {
        let island = &row["island"];
        let moved = read(island, saved_at_ms(&row)).unwrap().expect("not moved yet");
        let state = &moved.life["state"];
        for k in ["houses", "scarecrows", "ships", "packs", "vehicles", "demand", "weather"] {
            assert!(state.get(k).is_none(), "{}: {k} left in the life", row["name"]);
        }
        assert_eq!(state["version"], 4);
        // The life is everything else it was, as it was.
        let old: LifeState = serde_json::from_value(island["state"].clone()).unwrap();
        let now: LifeState = serde_json::from_value(state.clone()).unwrap();
        assert_eq!(
            (now.coins, now.staked, now.bag.clone(), now.quests.clone(), now.next_id),
            (old.coins, old.staked, old.bag.clone(), old.quests.clone(), old.next_id)
        );
        // Every piece is in its land, and its times have moved onto the world's clock by the same
        // amount: what was left of the tax is left of it still.
        let count = |k: &str| island["state"][k].as_array().map_or(0, Vec::len);
        let l = &moved.land;
        assert_eq!(
            (l.houses.len(), l.scarecrows.len(), l.ships.len(), l.packs.len(), l.vehicles.len()),
            (count("houses"), count("scarecrows"), count("ships"), count("packs"), count("vehicles")),
            "{}",
            row["name"]
        );
        let by = saved_at_ms(&row).unwrap() as f64 / 1000.0 - old.clock;
        for (h, was) in l.houses.iter().zip(island["state"]["houses"].as_array().unwrap()) {
            let left_then = was["taxPaidUntil"].as_f64().unwrap() - old.clock;
            assert!((h.tax_paid_until - (saved_at_ms(&row).unwrap() as f64 / 1000.0) - left_then).abs() < 1e-6);
            assert!((h.tax_paid_until - was["taxPaidUntil"].as_f64().unwrap() - by).abs() < 1e-6);
        }
    }
    // The settler's land, whole: a finished cottage with its chest, a farm with a fed chicken, a cog
    // half built, a pack on the ground, a cart with a crate in its bed, a crate on their back.
    let settler = fixtures().into_iter().find(|r| r["name"] == "Settler").unwrap();
    let l = read(&settler["island"], saved_at_ms(&settler)).unwrap().unwrap().land;
    assert_eq!((l.houses[0].stage, l.houses[0].storage.len()), (4, 3));
    assert!(l.scarecrows[0].cells.iter().flatten().any(|p| p.is_animal() && p.fed_until.unwrap_or(0.0) > 1.7e9));
    let cart = &l.vehicles[0];
    assert_eq!(l.packs.iter().find(|p| p.at == "cargo").map(|p| (p.vehicle, cart.cargo[0] == p.id)), Some((cart.id, true)));
    // Moved already: nothing more to do.
    let moved = read(&settler["island"], saved_at_ms(&settler)).unwrap().unwrap();
    assert_eq!(read(&moved.life, None).unwrap(), None);
}

#[tokio::test]
async fn saves_from_before_land_had_rows_come_back_with_everything() {
    let Some(db) = fresh("migration").await else { return };
    let rows = fixtures();
    let account: i64 = sqlx::query_scalar("INSERT INTO accounts (username, username_key, password_hash) VALUES ('fixtures', 'fixtures', 'x') RETURNING id")
        .fetch_one(&db)
        .await
        .unwrap();
    for r in &rows {
        // (Each was played in its home channel then: `home_channel`, gone since the channels' policy.)
        sqlx::query("INSERT INTO characters (id, account_id, name, island, build, saved_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)")
            .bind(r["id"].as_i64().unwrap())
            .bind(account)
            .bind(r["name"].as_str().unwrap())
            .bind(Json(&r["island"]))
            .bind(r.get("build").filter(|b| !b.is_null()).map(Json))
            .bind(r["saved_at"].as_str().unwrap())
            .execute(&db)
            .await
            .unwrap();
    }
    let report = migrate::run(&db).await.unwrap();
    assert_eq!((report.characters, report.left), (rows.len() as u64, 0));
    // Rise-1 was built on in three channels: by 12 (the first made), 101 and 102. 12 keeps it; the
    // others' houses are moved, whole, to the first plots nobody holds; 105 keeps rise-3.
    assert_eq!(report.moved, [(101, "rise-1".into(), "rise-2".into()), (102, "rise-1".into(), "rise-4".into())]);
    assert!(report.taken_down.is_empty());
    let held = claims(&db).await.unwrap();
    let who: BTreeMap<&str, i64> = held.iter().map(|(p, (h, _))| (p.as_str(), *h)).collect();
    assert_eq!(who, BTreeMap::from([("rise-1", 12), ("rise-2", 101), ("rise-3", 105), ("rise-4", 102)]));
    // Every character back with everything: their life as it was, and their land as it was (by
    // their own ids, which are now the world's), wherever its house now stands.
    for r in &rows {
        let id = r["id"].as_i64().unwrap();
        let expected = read(&r["island"], saved_at_ms(r)).unwrap().unwrap();
        let island: Value = sqlx::query_scalar::<_, Json<Value>>("SELECT island FROM characters WHERE id = $1").bind(id).fetch_one(&db).await.unwrap().0;
        assert_eq!(island, expected.life, "{id}'s life");
        let mut want = expected.land.clone();
        for (c, from, to) in &report.moved {
            if *c == id {
                want.houses.iter_mut().filter(|h| &h.plot == from).for_each(|h| h.plot = to.clone());
            }
        }
        let got = load_holding(&db, id).await.unwrap();
        assert_eq!(without_ids(&got), without_ids(&want), "{id}'s land");
        // Each piece's id is the world's own now (from a block), and its plot's claim names its house.
        assert!(got.houses.iter().chain([].iter()).all(|h| h.id >= BLOCK));
        for h in &got.houses {
            let house: i64 = sqlx::query_scalar("SELECT house FROM plots WHERE plot = $1").bind(&h.plot).fetch_one(&db).await.unwrap();
            assert_eq!(house, h.id);
        }
    }
    // A second start finds nothing left to move.
    assert_eq!(migrate::run(&db).await.unwrap(), migrate::Report::default());
}
