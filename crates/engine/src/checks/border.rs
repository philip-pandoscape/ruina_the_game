//! The border's check: a crowd (crate::checks::crowd's scenarios: players and bots fighting,
//! healing and casting, creatures among them, a cart with a passenger) played on Emberholm as one
//! simulation, and as the world split between several (crate::border::split), tick for tick the
//! same to the bit. Each tick comes back as a hash of everything in it, in an order of its own
//! rather than any simulation's: every player (by slot) as the browser reads them, what each was
//! told and said, their vehicles; every creature, missile, arrow and meteor; what was shown, every
//! slam and blow; the fight's numbers summed. The golden file keeps the answer one simulation
//! gives, and every split a case lists (`splits`) must give it too: along a line of chunks (`x`),
//! or into four round a corner (`corner`).

use serde::Deserialize;
use serde_json::{Value, json};

use super::crowd::{STEPS, Scenario, TICK_HZ, build_of, effects, fnv, pressing, tick_json};
use crate::actors::{Actors, StepOut};
use crate::border::messages::Input;
use crate::border::split::Split;
use crate::border::{Owners, SimId};
use crate::bots::{Bot, Brain};
use crate::ids::EntityId;
use crate::jsmath::JsMath;
use crate::life::content::rideable;
use crate::life::{Life, vehicles};
use crate::open::Sim as Stepping;
use crate::open::colliders::ground_at;
use crate::open::map::world_map;
use crate::open::zone::emberholm;
use crate::player::{Actions, Player};
use crate::session::player_state_json;
use crate::world::Spawn;

/// How the posts between simulations travel: passed as they are, written out to count their bytes,
/// or written out and read back as between processes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Posts {
    Passed,
    Counted,
    Written,
}

/// How a world is split between simulations.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Rule {
    /// Two: west of chunk `x` the first's, the rest the second's.
    X(i32),
    /// Four, meeting at the corner of chunk (x, z).
    Corner(i32, i32),
    /// In chunks of `chunk` metres, finer than the world's so a line can run through a fight: west
    /// of `x` and south of `z` metres (either, or both for four) the first's.
    Line { chunk: f64, x: Option<f64>, z: Option<f64> },
}

impl Rule {
    pub fn owners(self) -> Owners {
        let map = world_map();
        match self {
            Rule::X(x) => Owners::split_x(map, x, SimId(1), SimId(2)),
            Rule::Corner(x, z) => Owners::of(map, |cx, cz| SimId(1 + u64::from(cx >= x) + 2 * u64::from(cz >= z))),
            Rule::Line { chunk, x, z } => Owners::grid(map, chunk, |cx, cz| {
                let (east, north) = (x.is_some_and(|x| f64::from(cx) * chunk >= x), z.is_some_and(|z| f64::from(cz) * chunk >= z));
                SimId(1 + u64::from(east) + 2 * u64::from(north))
            }),
        }
    }
}

/// A golden case: a crowd, and the splits that must play it as one simulation does.
#[derive(Deserialize)]
struct Case {
    #[serde(flatten)]
    crowd: Scenario,
    #[serde(default)]
    splits: Vec<Rule>,
}

/// Runs a case as one simulation and gives back a hash of each tick, and each life and its land at the end.
pub fn run(input: &str) -> serde_json::Result<String> {
    let case: Case = serde_json::from_str(input)?;
    Ok(answer(&case.crowd, None, Posts::Passed))
}

/// The same, split by `rule` (with every post written out and read back if `wire`).
pub fn run_split(input: &str, rule: Rule, wire: bool) -> serde_json::Result<String> {
    let posts = if wire { Posts::Written } else { Posts::Passed };
    let case: Case = serde_json::from_str(input)?;
    Ok(answer(&case.crowd, Some(rule), posts))
}

/// The splits a case lists.
pub fn splits(input: &str) -> serde_json::Result<Vec<Rule>> {
    let case: Case = serde_json::from_str(input)?;
    Ok(case.splits)
}

fn answer(s: &Scenario, rule: Option<Rule>, posts: Posts) -> String {
    let mut played = play(s, rule, posts, false);
    let islands = islands(&mut played.split);
    json!({ "ticks": played.ticks, "islands": islands }).to_string()
}

/// A scenario played out.
pub(crate) struct Played {
    pub split: Split,
    /// Each tick's hash, in the border's own order.
    pub ticks: Vec<String>,
    /// Each tick's hash as the crowd's check makes it, when played as one simulation (`crowd`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub crowd: Vec<String>,
    /// Each tick written out whole, when asked for (to see where two answers part).
    #[cfg_attr(not(test), allow(dead_code))]
    pub texts: Vec<String>,
}

/// A fighter's character, its id and its slot: its place in the list (plus one for the first two).
fn character(k: usize) -> i64 {
    k as i64 + 1
}

fn client(k: usize) -> EntityId {
    EntityId::character(character(k))
}

/// Plays a scenario: as one simulation (`rule` none) or split; each tick hashed in the border's
/// order, and in the crowd's too if `crowd` (one simulation only).
pub(crate) fn play(s: &Scenario, rule: Option<Rule>, posts: Posts, crowd: bool) -> Played {
    play_keeping(s, rule, posts, crowd, false)
}

/// The same, keeping each tick written out whole if `keep`.
pub(crate) fn play_keeping(s: &Scenario, rule: Option<Rule>, posts: Posts, crowd: bool, keep: bool) -> Played {
    let zone = emberholm();
    let map = world_map();
    let owners = rule.map_or_else(|| Owners::one(map, SimId(1)), Rule::owners);
    let mut split = Split::new(map, zone, Some(&zone.terrain), owners, 1000.0 / f64::from(TICK_HZ));
    split.wire = posts == Posts::Written;
    split.count = posts != Posts::Passed;
    // Everyone in their slot (their place in the list), where they stand; a passenger with their
    // driver.
    let hf = map;
    for (k, f) in s.fighters.iter().enumerate() {
        let index = &split.sims[0].world.index;
        let mut p = Player::new(Spawn { x: f.x, z: f.z, facing: f.facing }, f.team, build_of(f));
        p.pos.y = ground_at(hf, index, f.x, f.z, hf.height(f.x, f.z) + 1.2, 1.2);
        p.grounded = true;
        let with = f.rides.map(|h| split.owners.owner_at(s.fighters[h].x, s.fighters[h].z));
        split.join(k, client(k), character(k), p, Box::new(Life::new(zone, None, None)), with);
        if let Some(name) = &f.brain {
            split.add_bot(k, Bot::new(Brain::named(name).expect("a brain"), f.seed, (f.x, f.z)));
        }
    }
    // The vehicles out, their owners in the driver's seat; then the friends riding along.
    let mut carts: Vec<(usize, i64)> = Vec::new();
    for (k, f) in s.fighters.iter().enumerate() {
        let Some(drive) = &f.drives else { continue };
        let at = split.owner_of(k).expect("the driver");
        let sim = split.sim_mut(at);
        let (p, life) = sim.players.open_mut(client(k)).expect("the driver");
        let life = life.expect("an island");
        life.give(&drive.deed, 1, true);
        let world = &sim.world;
        let id = vehicles::summon(life, &mut Stepping { player: p, world, owner: character(k) }, &drive.deed).expect("a vehicle on the road");
        let v = life.land.vehicles.iter().find(|v| v.id == id).expect("the vehicle").clone();
        let (x, _, z) = vehicles::anchor_world(&v, &rideable(&v.def).seats[0]);
        p.pos.x = x + v.heading.js_cos();
        p.pos.z = z - v.heading.js_sin();
        assert!(vehicles::board(life, &mut Stepping { player: p, world, owner: character(k) }, id), "in the driver's seat");
        carts.push((k, id));
    }
    for (k, f) in s.fighters.iter().enumerate() {
        let Some(host) = f.rides else { continue };
        let &(_, id) = carts.iter().find(|(d, _)| *d == host).expect("a vehicle to ride in");
        let at = split.owner_of(k).expect("the passenger");
        let sim = split.sim_mut(at);
        let v = sim.players.vehicle_of(character(host), id).expect("the vehicle, with its driver");
        let (x, _, z) = vehicles::anchor_world(&v, &rideable(&v.def).seats[1]);
        let p = sim.players.open_mut(client(k)).expect("the passenger").0;
        p.pos.x = x - 1.2 * v.heading.js_cos();
        p.pos.z = z + 1.2 * v.heading.js_sin();
        assert!(sim.players.ride_along(client(k), character(host), id, "Driver"), "riding along");
    }
    // The creatures, numbered as one simulation numbers them, each with the simulation its home is in.
    let mut actors = Actors::new();
    for c in &s.creatures {
        if c.band != 0 {
            actors.spawn_in_band(&c.kind, c.x, c.z, 0.0, c.seed, c.band);
        } else {
            actors.spawn(&c.kind, c.x, c.z, c.seed);
        }
    }
    split.place_creatures(actors);

    let mut seq = vec![0u32; s.fighters.len()];
    let (mut ticks, mut crowds, mut texts) = (Vec::with_capacity(s.ticks as usize), Vec::new(), Vec::new());
    for tick in 1..=s.ticks {
        split.begin_tick(tick, f64::from(STEPS), s.lag);
        // Everyone's presses: the bots' brains (with whoever owns them), the casts, the drivers'
        // sticks and the walkers' ways.
        let mut pressed: Vec<Actions> = s.fighters.iter().map(pressing).collect();
        for (slot, a) in split.think() {
            pressed[slot] = a;
        }
        for (k, f) in s.fighters.iter().enumerate() {
            if f.cast > 0 && tick % f.cast == 0 {
                pressed[k].ability_slot = 1;
            }
        }
        let view = tick as f64 - 1.0 - s.lag;
        for (k, a) in pressed.into_iter().enumerate() {
            let first = seq[k] + 1;
            seq[k] += STEPS;
            // A press counts once: on the first of the tick's steps.
            let held = Actions { attack_pressed: false, jump_pressed: false, slide_pressed: false, ability_slot: 0, movement_slot: 0, ..a };
            let inputs = (0..STEPS).map(|n| Input { seq: first + n, view: Some(view), actions: if n == 0 { a } else { held } }).collect();
            split.queue(client(k), inputs);
        }
        let done = split.finish_tick();
        if crowd {
            assert_eq!(split.sims.len(), 1, "the crowd's order is one simulation's");
            let s = &split.sims[0];
            ticks_hash(&mut crowds, &tick_json(&s.players, &s.actors, &done[0].1));
        }
        let canon = canon(&mut split, &done);
        ticks_hash(&mut ticks, &canon);
        if keep {
            texts.push(serde_json::to_string_pretty(&canon).unwrap_or_default());
        }
        split.end_tick();
    }
    Played { split, ticks, crowd: crowds, texts }
}

fn ticks_hash(out: &mut Vec<String>, v: &Value) {
    let h = fnv(0xcbf2_9ce4_8422_2325, &v.to_string());
    out.push(format!("{h:016x}"));
}

/// Lists of numbers in an order of their own (each number's bits, in turn), not any simulation's.
fn sorted(mut rows: Vec<Vec<f64>>) -> Vec<Vec<f64>> {
    rows.sort_by(|a, b| a.iter().zip(b).map(|(x, y)| x.total_cmp(y)).find(|o| o.is_ne()).unwrap_or(a.len().cmp(&b.len())));
    rows
}

/// Everything there is at the end of a tick, every simulation's together, in an order no simulation
/// decides: the players by slot (as the browser reads them, what each was told and said, their
/// vehicles), the creatures and missiles by id, arrows and meteors by when and by whom they were
/// loosed, and what was shown, slammed and struck as sorted lists; the fight's numbers summed.
pub fn canon(split: &mut Split, done: &[(SimId, StepOut)]) -> Value {
    let mut players: Vec<(usize, Value)> = Vec::new();
    let (mut creatures, mut missiles, mut arrows, mut meteors, mut shown) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut fight = [0u64; 4];
    for s in &mut split.sims {
        for (slot, client) in s.own() {
            let told = effects(s.players.told(slot));
            let Some((p, life)) = s.players.open_mut(client) else { continue };
            let state = player_state_json(p);
            let (vehicles, said) = match life {
                Some(l) => (json!(l.land.vehicles), json!(l.drain_events())),
                None => (Value::Null, Value::Null),
            };
            let owner = s.players.owner_of_slot(slot).unwrap_or(0);
            players.push((slot, json!({ "slot": slot, "id": owner, "p": state, "told": told, "vehicles": vehicles, "said": said })));
        }
        creatures.extend(s.actors.list.iter().map(super::ai::row));
        missiles.extend(s.actors.missiles.iter().map(|m| vec![f64::from(m.id), m.x, m.y, m.z, m.vy]));
        arrows.extend(s.players.arrows().iter().map(|a| {
            let l = a.loosed();
            vec![l.tick as f64, l.slot as f64, f64::from(l.n), a.x, a.y, a.z]
        }));
        meteors.extend(s.players.meteors().iter().map(|m| {
            let l = m.loosed();
            vec![l.tick as f64, l.slot as f64, f64::from(l.n), m.x, m.z, f64::from(m.ticks_left)]
        }));
        shown.extend(effects(s.players.shown()).into_iter().map(|e| e.to_vec()));
        let pl = &s.players;
        for (k, n) in [pl.pvp_hits, pl.saved_by_rewind, pl.heals, pl.meteors_landed].into_iter().enumerate() {
            fight[k] += n;
        }
    }
    players.sort_by_key(|(slot, _)| *slot);
    let (mut slams, mut hits) = (Vec::new(), Vec::new());
    for (_, d) in done {
        slams.extend(d.slams.iter().map(|s| vec![s.x, s.z, s.radius, s.damage]));
        hits.extend(d.hits.iter().map(|h| vec![f64::from(h.foe), h.damage, h.nx, h.nz, h.knock]));
    }
    json!({
        "players": players.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "creatures": sorted(creatures),
        "missiles": sorted(missiles),
        "arrows": sorted(arrows),
        "meteors": sorted(meteors),
        "shown": sorted(shown),
        "slams": sorted(slams),
        "hits": sorted(hits),
        "fight": fight,
    })
}

/// Every island at the end, by slot.
pub fn islands(split: &mut Split) -> Vec<Value> {
    let mut out: Vec<(usize, Value)> = Vec::new();
    for s in &split.sims {
        for (slot, client) in s.own() {
            let Some((_, _, life)) = s.players.open_view(client) else { continue };
            let owner = s.players.owner_of_slot(slot).unwrap_or(0);
            out.push((slot, json!({ "id": owner, "state": life.map(|l| &l.state), "land": life.map(|l| &l.land) })));
        }
    }
    out.sort_by_key(|(slot, _)| *slot);
    out.into_iter().map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A golden file's first case, as its check runs it.
    fn case(check: &str) -> String {
        let path = format!("{}/tests/golden/{check}.json", env!("CARGO_MANIFEST_DIR"));
        let file: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the golden file")).expect("golden JSON");
        file["cases"][0]["input"].to_string()
    }

    #[test]
    fn played_as_one_simulation_the_crowd_is_the_crowd_s_check_tick_for_tick() {
        // The harness, with one simulation owning everything, steps a tick as the crowd's check
        // (and the server's play_tick) does: the same answer, hash for hash, the islands too.
        let input = case("crowdcheck");
        let s: Scenario = serde_json::from_str(&input).expect("a scenario");
        let mut played = play(&s, None, Posts::Passed, true);
        let islands: Vec<Value> = islands(&mut played.split);
        let mine = json!({ "ticks": played.crowd, "islands": islands }).to_string();
        assert_eq!(mine, super::super::crowd::run(&input).expect("the crowd runs"));
    }

    /// The first tick two answers part at, if they do.
    fn parted(one: &Played, other: &Played) -> Option<usize> {
        one.ticks.iter().zip(&other.ticks).position(|(a, b)| a != b)
    }

    /// Where a split crowd parts from one simulation's: both ticks written out to scratch/, to
    /// compare (`cargo test --release -p ruina-engine where_a_split_parts -- --ignored`).
    #[test]
    #[ignore]
    fn where_a_split_parts() {
        let input = case("crowdcheck");
        let s: Scenario = serde_json::from_str(&input).expect("a scenario");
        let rule = Rule::Line { chunk: 4.0, x: None, z: Some(-44.0) };
        let one = play_keeping(&s, None, Posts::Passed, false, true);
        let split = play_keeping(&s, Some(rule), Posts::Passed, false, true);
        if let Some(t) = parted(&one, &split) {
            let dir = format!("{}/../../scratch", env!("CARGO_MANIFEST_DIR"));
            std::fs::write(format!("{dir}/one.json"), &one.texts[t]).expect("written");
            std::fs::write(format!("{dir}/split.json"), &split.texts[t]).expect("written");
            panic!("parted at tick {}", t + 1);
        }
    }

    #[test]
    fn the_crowd_split_plays_as_one() {
        let input = case("crowdcheck");
        let s: Scenario = serde_json::from_str(&input).expect("a scenario");
        let one = play(&s, None, Posts::Passed, false);
        for rule in [Rule::X(0), Rule::Corner(0, 0), Rule::Line { chunk: 4.0, x: None, z: Some(-44.0) }] {
            let split = play(&s, Some(rule), Posts::Passed, false);
            assert_eq!(parted(&one, &split), None, "{rule:?}");
        }
    }

    #[test]
    fn across_the_border_walkers_and_a_cart_with_its_passenger_are_handed_over() {
        // The second case, Emberholm split at x = 0: a walker each way, and a cart with a
        // passenger, cross; the two sides fight across the line, creatures either side of it.
        let path = format!("{}/tests/golden/bordercheck.json", env!("CARGO_MANIFEST_DIR"));
        let file: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the golden file")).expect("golden JSON");
        let s: Scenario = serde_json::from_value(file["cases"][1]["input"].clone()).expect("a scenario");
        let one = play(&s, None, Posts::Passed, false);
        let mut split = play(&s, Some(Rule::X(0)), Posts::Counted, false);
        assert_eq!(parted(&one, &split), None);
        let c = split.split.counts.clone();
        eprintln!("{c:?}");
        // The walkers ended up across the line, each the other side's now.
        let (west, east) = (SimId(1), SimId(2));
        let first = s.fighters.iter().position(|f| f.walks.is_some()).expect("walkers");
        assert_eq!(split.split.owner_of(first), Some(east), "the walker going east");
        assert_eq!(split.split.owner_of(first + 1), Some(west), "the walker going west");
        // The cart's driver and its passenger went over as one, and sit in it there.
        let driver = s.fighters.iter().position(|f| f.drives.is_some()).expect("a driver");
        let passenger = s.fighters.iter().position(|f| f.rides == Some(driver)).expect("a passenger");
        assert_eq!((split.split.owner_of(driver), split.split.owner_of(passenger)), (Some(east), Some(east)));
        let sim = split.split.sim_mut(east);
        let (d, _, life) = sim.players.open_view(client(driver)).expect("the driver");
        let v = &life.expect("an island").land.vehicles[0];
        assert!(v.x > 28.0, "the cart is {} m past the line", v.x);
        assert_eq!(d.vehicle, v.id);
        let p = sim.players.open_view(client(passenger)).expect("the passenger").0;
        assert_eq!((p.host, p.vehicle), (character(driver), v.id));
        assert!(c.handoffs >= 3, "{c:?}");
        assert!(c.across_bytes > 0 && c.struck_bytes > 0, "{c:?}");
    }

    /// What borders cost, for the report: what crosses (bytes written out as JSON) and the time a
    /// tick takes split against one simulation (`cargo test --release -p ruina-engine
    /// what_borders_cost -- --ignored --nocapture`).
    #[test]
    #[ignore]
    #[allow(clippy::disallowed_methods, clippy::disallowed_types)]
    fn what_borders_cost() {
        let path = format!("{}/tests/golden/bordercheck.json", env!("CARGO_MANIFEST_DIR"));
        let file: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the golden file")).expect("golden JSON");
        for (case, rule) in [(0, Rule::Line { chunk: 4.0, x: None, z: Some(-44.0) }), (1, Rule::X(0))] {
            let s: Scenario = serde_json::from_value(file["cases"][case]["input"].clone()).expect("a scenario");
            let time = |rule: Option<Rule>| {
                let t = std::time::Instant::now();
                for _ in 0..5 {
                    play(&s, rule, Posts::Passed, false);
                }
                t.elapsed().as_secs_f64() * 1000.0 / 5.0 / s.ticks as f64
            };
            let (one, split) = (time(None), time(Some(rule)));
            let counted = play(&s, Some(rule), Posts::Counted, false);
            let c = &counted.split.counts;
            let ticks = s.ticks as f64;
            eprintln!("case {case} {rule:?}: {:.3} ms a tick as one, {:.3} split", one, split);
            eprintln!(
                "  ghosts {:.0} B a tick ({:.1} players, {:.1} creatures a tick; {:.0} B a ghost on average); across {:.0} B a tick; struck {:.0} B a tick; {} handoffs, {} B in all, the biggest {} B",
                c.ghost_bytes as f64 / ticks,
                c.ghost_players as f64 / ticks,
                c.ghost_creatures as f64 / ticks,
                c.ghost_bytes as f64 / (c.ghost_players + c.ghost_creatures).max(1) as f64,
                c.across_bytes as f64 / ticks,
                c.struck_bytes as f64 / ticks,
                c.handoffs,
                c.handoff_bytes,
                c.handoff_most
            );
            // One of each, written out on its own.
            let sim = &counted.split.sims[0];
            let slot = sim.own().first().expect("someone").0;
            let p = sim.players.player(slot).expect("the player").clone();
            let g = crate::border::messages::GhostPlayer {
                slot,
                client: client(slot),
                owner: 1,
                epoch: crate::border::Epoch(1),
                player: p,
                vehicles: Vec::new(),
                history: None,
            };
            let with = crate::border::messages::GhostPlayer { history: Some(sim.players.history(slot)), ..g.clone() };
            let creature =
                sim.actors.list.first().map(|a| serde_json::to_string(&crate::border::messages::GhostCreature::of(a, None)).unwrap_or_default().len());
            eprintln!(
                "  a ghost player {} B ({} B with its history), a ghost creature {:?} B",
                serde_json::to_string(&g).unwrap_or_default().len(),
                serde_json::to_string(&with).unwrap_or_default().len(),
                creature
            );
        }
    }

    #[test]
    fn split_through_the_fight_its_blows_and_heals_cross_written_out_and_read_back() {
        // The two sides on either side of a line through the fight: everything that crosses goes
        // as a post written out and read back, as between processes, and it still plays as one.
        let input = case("crowdcheck");
        let s: Scenario = serde_json::from_str(&input).expect("a scenario");
        let one = play(&s, None, Posts::Passed, false);
        let split = play(&s, Some(Rule::Line { chunk: 4.0, x: None, z: Some(-44.0) }), Posts::Written, false);
        assert_eq!(parted(&one, &split), None);
        let c = &split.split.counts;
        eprintln!("{c:?}");
        assert!(c.across_bytes > 0 && c.ghost_players > 0 && c.ghost_creatures > 0 && c.struck_bytes > 0, "{c:?}");
    }
}
