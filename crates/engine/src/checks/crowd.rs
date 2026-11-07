//! The crowd's check: a channel's tick on Emberholm, phase by phase as the server's play_tick steps
//! it (crate::combat), with everything in it at once. Players fight on two sides, bots' brains
//! filling their inputs (crate::bots), some casting Healing Circles and meteors, all seeing the
//! others a few ticks late as players do (so their swings are rewound); a war-band of goblins and
//! slimes are among them; and a farm cart goes up the road, its owner driving and a friend riding
//! along. Each tick comes back as a hash of everything in it (every player as the browser reads
//! them, what each was told, every creature, missile, arrow and meteor, every slam and blow), and
//! the islands at the end in full.
//!
//! `order`, a seed, steps everything in an order of its own (with the engine's own random numbers):
//! the bots' brains, the players and the creatures, each shuffled afresh every tick (the creatures
//! every frame). The order must change nothing, so a shuffled scenario gives the answer kept for it
//! in order.

use std::collections::VecDeque;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::actor::Actor;
use crate::actors::{Actors, LEAN_DAMPING, LEAN_SPRING, StepOut};
use crate::bots::{Bot, Brain, FoeSeen};
use crate::combat::{Effect, Players};
use crate::jsmath::JsMath;
use crate::life::content::rideable;
use crate::life::{Life, vehicles};
use crate::missiles::Missile;
use crate::open::colliders::ground_at;
use crate::open::zone::emberholm;
use crate::open::{OpenWorld, Sim};
use crate::player::{Actions, Build, Player};
use crate::rng::Rng;
use crate::session::player_state_json;
use crate::skills::skills_from;
use crate::tuning::{NO_ABILITY, tuning};
use crate::world::{Spawn, World};

/// Ticks a second, as the server runs them, and steps (inputs) a tick.
const TICK_HZ: u32 = 20;
const STEPS: u32 = 60 / TICK_HZ;

#[derive(Deserialize)]
struct Fighter {
    x: f64,
    z: f64,
    #[serde(default)]
    facing: f64,
    #[serde(default)]
    team: u8,
    /// The brain that fills its inputs ("skirmisher", "wanderer"); with none it stands still,
    /// unless it drives.
    #[serde(default)]
    brain: Option<String>,
    #[serde(default)]
    seed: u32,
    /// Its build: skills by id, weapon by place, the ability in its first slot by id.
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    weapon: u8,
    #[serde(default)]
    ability: Option<String>,
    /// Every this many ticks it casts that ability (0 never).
    #[serde(default)]
    cast: u64,
    /// A vehicle it drives up the road.
    #[serde(default)]
    drives: Option<Drive>,
    /// Rides along in the vehicle of the fighter at this place in the list.
    #[serde(default)]
    rides: Option<usize>,
}

#[derive(Deserialize)]
struct Drive {
    /// The deed it summons the vehicle with.
    deed: String,
    /// How far over it holds the stick, the whole way.
    stick: f64,
}

#[derive(Deserialize)]
struct Creature {
    kind: String,
    x: f64,
    z: f64,
    seed: u32,
    /// The war-band it fights in, 0 for none.
    #[serde(default)]
    band: u32,
}

#[derive(Deserialize)]
struct Scenario {
    fighters: Vec<Fighter>,
    #[serde(default)]
    creatures: Vec<Creature>,
    ticks: u64,
    /// How many ticks behind everyone sees the others (the view tick their inputs carry).
    #[serde(default)]
    lag: f64,
    /// A seed to step everything in an order of its own; none steps it in order.
    #[serde(default)]
    order: Option<u32>,
}

/// FNV-1a, 64 bits, over a text, carried on from `h`.
fn fnv(mut h: u64, text: &str) -> u64 {
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn effects(list: &[Effect]) -> Vec<[f64; 5]> {
    list.iter().map(|e| [f64::from(e.kind), e.x, e.y, e.z, f64::from(e.size)]).collect()
}

fn build_of(f: &Fighter) -> Build {
    let ids: Vec<&str> = f.skills.iter().map(String::as_str).collect();
    let mut b = Build { skills: skills_from(&ids), weapon: f.weapon, ..Build::default() };
    if let Some(a) = &f.ability {
        b.abilities[0] = tuning().abilities.iter().position(|x| &x.id == a).expect("an ability") as u8;
    } else {
        b.abilities[0] = NO_ABILITY;
    }
    b
}

/// Everything there is at the end of a tick, as JSON: the players (by character), what each was
/// told, their vehicles; the creatures, missiles, arrows and meteors; the slams and blows that
/// landed; the fight's numbers.
fn tick_json(players: &Players, actors: &Actors, done: &StepOut) -> Value {
    let list: Vec<Value> = players
        .each_open()
        .map(|(client, owner, p, life)| {
            let told = players.slot_index(client).map(|s| effects(players.told(s))).unwrap_or_default();
            json!({ "id": owner, "p": player_state_json(p), "told": told, "vehicles": life.map(|l| &l.state.vehicles) })
        })
        .collect();
    let mut creatures: Vec<&Actor> = actors.list.iter().collect();
    creatures.sort_by_key(|a| a.id);
    let mut missiles: Vec<&Missile> = actors.missiles.iter().collect();
    missiles.sort_by_key(|m| m.id);
    json!({
        "players": list,
        "creatures": creatures.into_iter().map(super::ai::row).collect::<Vec<_>>(),
        "missiles": missiles.into_iter().map(|m| [f64::from(m.id), m.x, m.y, m.z, m.vy]).collect::<Vec<_>>(),
        "arrows": players.arrows().iter().map(|a| [f64::from(a.id), a.x, a.y, a.z]).collect::<Vec<_>>(),
        "meteors": players.meteors().iter().map(|m| [f64::from(m.id), m.x, m.z, f64::from(m.ticks_left)]).collect::<Vec<_>>(),
        "shown": effects(players.shown()),
        "slams": done.slams.iter().map(|s| [s.x, s.z, s.radius, s.damage]).collect::<Vec<_>>(),
        "hits": done.hits.iter().map(|h| [f64::from(h.foe), h.damage, h.nx, h.nz, h.knock]).collect::<Vec<_>>(),
        "fight": [players.pvp_hits, players.saved_by_rewind, players.heals, players.meteors_landed],
        "rewindMs": players.rewind_ms(),
    })
}

/// Runs a scenario (JSON) and gives back a hash of each tick and the islands at the end (JSON).
pub fn run(input: &str) -> serde_json::Result<String> {
    let s: Scenario = serde_json::from_str(input)?;
    let (players, _, ticks) = play(&s);
    let islands: Vec<Value> = players.each_open().map(|(_, o, _, life)| json!({ "id": o, "state": life.map(|l| &l.state) })).collect();
    serde_json::to_string(&json!({ "ticks": ticks, "islands": islands }))
}

/// Plays a scenario out: the players and creatures as it left them, and each tick's hash.
fn play(s: &Scenario) -> (Players, Actors, Vec<String>) {
    let zone = emberholm();
    let r = &zone.recipe;
    let spawn = Spawn { x: r.spawn.x, z: r.spawn.z, facing: r.spawn.facing };
    let flat = World { radius: zone.radius, obstacles: Vec::new(), team_spawns: [spawn, spawn] };
    let mut world = OpenWorld::new(zone);
    let mut players = Players::new(1000.0 / f64::from(TICK_HZ));
    players.ground = Some(&zone.terrain);
    let hf = world.terrain();
    // A fighter's character is its place in the list plus one, and so is its client.
    let client = |k: usize| k as u32 + 1;
    let owner = |k: usize| k as i64 + 1;

    let mut bots: Vec<(usize, Bot)> = Vec::new();
    for (k, f) in s.fighters.iter().enumerate() {
        let mut p = Player::new(Spawn { x: f.x, z: f.z, facing: f.facing }, f.team, build_of(f));
        p.pos.y = ground_at(hf, &world.index, f.x, f.z, hf.height(f.x, f.z) + 1.2, 1.2);
        p.grounded = true;
        players.join_open(client(k), owner(k), p, Box::new(Life::new(zone, None, None)));
        if let Some(name) = &f.brain {
            bots.push((k, Bot::new(Brain::named(name).expect("a brain"), f.seed, (f.x, f.z))));
        }
    }
    // The vehicles out, their owners in the driver's seat; then the friends riding along.
    let mut carts: Vec<(usize, i64)> = Vec::new();
    for (k, f) in s.fighters.iter().enumerate() {
        let Some(drive) = &f.drives else { continue };
        let (p, life) = players.open_mut(client(k)).expect("the driver");
        let life = life.expect("an island");
        life.give(&drive.deed, 1, true);
        let id = vehicles::summon(life, &mut Sim { player: p, world: &world, owner: owner(k) }, &drive.deed).expect("a vehicle on the road");
        let v = life.state.vehicles.iter().find(|v| v.id == id).expect("the vehicle").clone();
        let (x, _, z) = vehicles::anchor_world(&v, &rideable(&v.def).seats[0]);
        p.pos.x = x + v.heading.js_cos();
        p.pos.z = z - v.heading.js_sin();
        assert!(vehicles::board(life, &mut Sim { player: p, world: &world, owner: owner(k) }, id), "in the driver's seat");
        carts.push((k, id));
    }
    for (k, f) in s.fighters.iter().enumerate() {
        let Some(host) = f.rides else { continue };
        let &(_, id) = carts.iter().find(|(d, _)| *d == host).expect("a vehicle to ride in");
        let v = players.vehicle_of(owner(host), id).expect("the vehicle");
        let (x, _, z) = vehicles::anchor_world(&v, &rideable(&v.def).seats[1]);
        let p = players.open_mut(client(k)).expect("the passenger").0;
        p.pos.x = x - 1.2 * v.heading.js_cos();
        p.pos.z = z + 1.2 * v.heading.js_sin();
        assert!(players.ride_along(client(k), owner(host), id, "Driver"), "riding along");
    }

    let mut actors = Actors::new();
    for c in &s.creatures {
        if c.band != 0 {
            actors.spawn_in_band(&c.kind, c.x, c.z, 0.0, c.seed, c.band);
        } else {
            actors.spawn(&c.kind, c.x, c.z, c.seed);
        }
    }
    let ground = |x: f64, z: f64| zone.terrain.height(x, z);

    let mut shuffle = s.order.map(Rng::new);
    let mut seq = vec![0u32; s.fighters.len()];
    let mut ticks: Vec<String> = Vec::with_capacity(s.ticks as usize);
    // What everyone looked like as each of the last few ticks began: a bot sees the others `lag`
    // ticks late, as a player's screen shows them, which is what its swings are judged against.
    let mut looked: VecDeque<Vec<(i64, u8, FoeSeen)>> = VecDeque::new();
    for tick in 1..=s.ticks {
        players.inputs_per_tick = f64::from(STEPS);
        players.gather_movers(&mut world);
        // Everyone's inputs for the tick: what the bots' brains decide (each seeing itself as it
        // is and the others `lag` ticks late), the cast buttons, the drivers' sticks, and nothing
        // pressed for the rest.
        looked.push_back(
            players.each_open().map(|(_, o, p, _)| (o, p.team, FoeSeen { x: p.pos.x, z: p.pos.z, hp: if p.down_frame >= 0 { 0.0 } else { p.hp } })).collect(),
        );
        while looked.len() > s.lag.ceil() as usize + 1 {
            looked.pop_front();
        }
        let everyone = &looked[0];
        let mut pressed: Vec<Actions> = s
            .fighters
            .iter()
            .map(|f| Actions { stick_y: f.drives.as_ref().map_or(0.0, |_| 1.0), stick_x: f.drives.as_ref().map_or(0.0, |d| d.stick), ..Actions::default() })
            .collect();
        if let Some(rng) = shuffle.as_mut() {
            rng.shuffle(&mut bots);
        }
        for (k, bot) in bots.iter_mut() {
            let Some((me, _, _)) = players.open_view(client(*k)) else { continue };
            let foes: Vec<FoeSeen> = everyone.iter().filter(|(o, team, _)| *o != owner(*k) && *team != me.team).map(|e| e.2).collect();
            pressed[*k] = bot.think(me, &foes);
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
            players.queue_actions(client(k), (0..STEPS).map(|n| (first + n, view, if n == 0 { a } else { held })));
        }
        match shuffle.as_mut() {
            // The players stepped in a shuffled order, and left in it.
            Some(rng) => players.step_by(&mut actors, &flat, tick, Some(&mut world), |jobs, step| {
                rng.shuffle(jobs);
                jobs.iter_mut().for_each(step);
            }),
            None => players.step_in(&mut actors, &flat, tick, Some(&mut world)),
        }
        players.seat_passengers(&world);
        players.step_effects(&mut actors);
        let foes = players.foes();
        let mut done = StepOut::default();
        for _ in 0..STEPS {
            if let Some(rng) = shuffle.as_mut() {
                rng.shuffle(&mut actors.list);
            }
            done.extend(actors.step(&foes, &ground, LEAN_SPRING, LEAN_DAMPING, 1.0 / 60.0));
        }
        players.apply_slams(&done.slams);
        players.apply_foe_hits(&done.hits);
        players.record_history(tick, &actors);
        let h = fnv(0xcbf2_9ce4_8422_2325, &tick_json(&players, &actors, &done).to_string());
        ticks.push(format!("{h:016x}"));
    }
    (players, actors, ticks)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The golden file's crowd, as the golden tests run it.
    fn crowd() -> Scenario {
        let path = format!("{}/tests/golden/crowdcheck.json", env!("CARGO_MANIFEST_DIR"));
        let file: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the golden file")).expect("golden JSON");
        serde_json::from_value(file["cases"][0]["input"].clone()).expect("a scenario")
    }

    #[test]
    fn the_crowd_fights_heals_casts_and_rides_along() {
        let s = crowd();
        let (players, actors, _) = play(&s);
        // Blows and arrows landed on players (some only because they were rewound to where their
        // swingers saw them), circles healed and meteors fell.
        assert!(players.pvp_hits > 20, "{} hits", players.pvp_hits);
        assert!(players.saved_by_rewind > 0, "nothing landed only because it was rewound");
        assert!(players.heals >= 3 && players.meteors_landed >= 2, "{} circles, {} meteors", players.heals, players.meteors_landed);
        // The creatures took blows and dealt them: someone went down among them.
        let hurt = actors.list.iter().filter(|a| a.hp < a.max_hp || a.dead_frame >= 0).count();
        assert!(hurt > 0, "no creature was hurt");
        let mauled = players.each_open().filter(|(_, _, p, _)| p.hp < tuning().combat.max_hp || p.down_frame >= 0).count();
        assert!(mauled > 4, "{mauled} players hurt");
        assert!(players.each_open().any(|(_, _, p, _)| p.down_frame >= 0), "nobody went down");
        // The cart went up the road with its passenger in his seat.
        let (k, f) = s.fighters.iter().enumerate().find(|(_, f)| f.drives.is_some()).expect("a driver");
        let (driver, _, life) = players.open_view(k as u32 + 1).expect("the driver");
        let v = &life.expect("an island").state.vehicles[0];
        let went = crate::jsmath::len(v.x - f.x, v.z - f.z);
        assert!(went > 10.0, "the cart went {went} m");
        assert_eq!(driver.vehicle, v.id);
        let (j, _) = s.fighters.iter().enumerate().find(|(_, f)| f.rides == Some(k)).expect("a passenger");
        let passenger = players.open_view(j as u32 + 1).expect("the passenger").0;
        assert_eq!((passenger.host, passenger.vehicle, passenger.seat), (k as i64 + 1, v.id, 1));
        let (x, y, z) = vehicles::anchor_world(v, &rideable(&v.def).seats[1]);
        assert_eq!((passenger.pos.x, passenger.pos.y, passenger.pos.z), (x, y, z));
    }
}
