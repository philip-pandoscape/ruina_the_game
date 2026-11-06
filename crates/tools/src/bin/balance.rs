//! Headless balance measurement: runs builds against each other under the real rules and reports
//! who wins, how fast, and how much damage each one landed.
//!
//! The point is regression detection, not an oracle. Both sides are driven by the same plain
//! fighter, so this measures what a build can do on paper — damage, reach, cooldowns, time to
//! kill — and not how hard a skill is to land in a real fight. Treat a big swing between runs as
//! a question worth asking, and keep the browser tests for whether something feels right.
//!
//! Reads a scenario as JSON on stdin and writes JSON on stdout:
//!   {"builds":[{"name":"sword","skills":["sword"],"weapon":0,"abilities":["heal"]}],
//!    "duels":16,"seed":1,"maxSeconds":30,"startDistance":8}

use std::collections::HashMap;
use std::io::Read;

use ruina_engine::actors::Actors;
use ruina_engine::player::{Build, Mode};
use ruina_engine::sim::Battle;
use ruina_engine::skills::{EMPTY_SKILLS, node_index, set_skill};
use ruina_engine::tuning::{HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, tuning};
use ruina_engine::world::{SEED, battlefield};
use ruina_server::combat::{Players, actions_from};
use serde::{Deserialize, Serialize};
// mulberry32, the generator the world uses, so a run is repeatable from its seed.
use ruina_engine::rng::Rng;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildIn {
    name: String,
    #[serde(default)]
    skills: Vec<String>,
    weapon: u8,
    #[serde(default)]
    abilities: Vec<String>, // ability ids, in hotbar order
    #[serde(default)]
    movement: Vec<String>, // movement skill ids, in Q / E order
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    builds: Vec<BuildIn>,
    #[serde(default = "default_duels")]
    duels: u32,
    #[serde(default = "default_seed")]
    seed: u32,
    #[serde(default = "default_seconds")]
    max_seconds: f64,
    #[serde(default = "default_distance")]
    start_distance: f64,
}

fn default_duels() -> u32 {
    16
}
fn default_seed() -> u32 {
    1
}
fn default_seconds() -> f64 {
    30.0
}
fn default_distance() -> f64 {
    8.0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pairing {
    a: String,
    b: String,
    duels: u32,
    a_wins: u32,
    b_wins: u32,
    draws: u32,
    a_win_rate: f64,
    mean_ticks: f64,   // over decided duels
    mean_seconds: f64, // the same, in seconds
    a_damage: f64,     // mean damage a dealt per duel
    b_damage: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    tick_hz: f64,
    duels_per_pairing: u32,
    pairings: Vec<Pairing>,
    /// Win rate per build across every pairing it took part in. The headline number: a build far
    /// from 0.5 is either dominating or unplayable.
    overall: Vec<(String, f64)>,
}

fn to_build(b: &BuildIn) -> Build {
    let mut skills = EMPTY_SKILLS;
    for id in &b.skills {
        let i = node_index(id).unwrap_or_else(|| panic!("unknown skill: {id}"));
        set_skill(&mut skills, i, true);
    }
    let mut abilities = [NO_ABILITY; HOTBAR_SLOTS];
    for (slot, id) in b.abilities.iter().take(HOTBAR_SLOTS).enumerate() {
        abilities[slot] = tuning().abilities.iter().position(|a| &a.id == id).unwrap_or_else(|| panic!("unknown ability: {id}")) as u8;
    }
    let mut movement = [NO_MOVEMENT; MOVEMENT_SLOTS];
    for (slot, id) in b.movement.iter().take(MOVEMENT_SLOTS).enumerate() {
        movement[slot] = tuning().movement_skills.iter().position(|m| &m.id == id).unwrap_or_else(|| panic!("unknown movement skill: {id}")) as u8;
    }
    Build { skills, weapon: b.weapon, abilities, movement }
}

struct Outcome {
    winner: Option<usize>, // slot
    ticks: u32,
    damage: [f64; 2],
}

/// One duel. Both fighters are driven the same way: close the gap, swing in range, and spend a
/// hotbar slot whenever it is off cooldown. Any difference in the result is the builds.
// `me` and `you` are the two duellists, indexes into every pair of arrays here.
#[allow(clippy::needless_range_loop)]
fn duel(a: &Build, b: &Build, seed: u32, max_ticks: u32, distance: f64) -> Outcome {
    let world = battlefield(SEED);
    let tick_ms = 1000.0 / tuning().sim_hz;
    let mut players = Players::new(0, tick_ms);
    let mut actors = Actors::new(); // a duel has no monsters in it
    let mut battle = Battle::new(0);
    let mut rng = Rng(seed);

    players.join(1, 1, &world); // team 0
    players.join(2, 2, &world); // team 1
    players.sync_build(1, 1, *a);
    players.sync_build(2, 1, *b);
    // Face each other across the opening gap, clear of the spawn crowd.
    players.place(0, -distance / 2.0, 0.0, std::f64::consts::FRAC_PI_2);
    players.place(1, distance / 2.0, 0.0, -std::f64::consts::FRAC_PI_2);

    let start_hp = [hp(&players, 0), hp(&players, 1)];
    let mut seq = [0u32, 0u32];

    for tick in 1..=max_ticks {
        for me in 0..2 {
            let you = 1 - me;
            let (mx, mz) = players.position(me).unwrap_or((0.0, 0.0));
            let (ex, ez) = players.position(you).unwrap_or((0.0, 0.0));
            let (dx, dz) = (ex - mx, ez - mz);
            let dist = (dx * dx + dz * dz).sqrt().max(1e-6);
            let Some(p) = players.player(me) else { continue };

            // Enough jitter that sixteen duels aren't one duel sixteen times.
            let wobble = (rng.next_f64() - 0.5) * 0.25;
            let (nx, nz) = (dx / dist + wobble, dz / dist);
            let reach = 2.2;
            let closing = dist > reach;
            // Swing whenever in range and not already mid-swing. attack_frame keeps its value
            // after a swing ends, so the mode is what says whether another one can start.
            let attack = !closing && p.mode != Mode::Attack && p.down_frame < 0;
            // Spend the first slot that is ready; aim is the enemy, in quarter metres.
            let slot = (0..HOTBAR_SLOTS).find(|&i| p.abilities[i] != NO_ABILITY && p.cooldowns[i] <= 0).map_or(0, |i| i as u8 + 1);

            let q = |v: f64| (v.clamp(-127.0, 127.0)) as i8 as u8;
            let buttons = if attack { 4u8 } else { 0 };
            let raw = [
                q(if closing { nx * 127.0 } else { 0.0 }),
                q(if closing { nz * 127.0 } else { 0.0 }),
                buttons,
                q(dx * 4.0),
                q(dz * 4.0),
                if dist < 14.0 { slot } else { 0 },
                0, // the plain fighter never reaches for a movement skill
                0, // nor holds a stance: it turns the way it goes
            ];
            seq[me] += 1;
            let client = me as u32 + 1;
            players.queue_inputs(client, std::iter::once((seq[me], (tick.saturating_sub(1)) * 16, raw)));
            let _ = actions_from(raw); // keeps the decoder in the build, and documents the shape
        }

        players.step(&mut battle, &mut actors, &world, tick as u64);
        players.step_effects(&mut battle, &mut actors);
        players.record_history(tick as u64);

        let hps = [hp(&players, 0), hp(&players, 1)];
        if std::env::var("BALANCE_TRACE").is_ok() && tick % 30 == 0 {
            let (ax, az) = players.position(0).unwrap_or((0.0, 0.0));
            let (bx, bz) = players.position(1).unwrap_or((0.0, 0.0));
            let pa = players.player(0).unwrap();
            eprintln!(
                "t{tick} a=({ax:.1},{az:.1}) b=({bx:.1},{bz:.1}) d={:.2} hp={:.0}/{:.0} mode={:?} af={} cd={:?}",
                ((ax - bx).powi(2) + (az - bz).powi(2)).sqrt(),
                hps[0],
                hps[1],
                pa.mode,
                pa.attack_frame,
                &pa.cooldowns[..2]
            );
        }
        if hps[0] <= 0.0 || hps[1] <= 0.0 {
            let winner = if hps[0] <= 0.0 && hps[1] <= 0.0 {
                None
            } else if hps[1] <= 0.0 {
                Some(0)
            } else {
                Some(1)
            };
            return Outcome { winner, ticks: tick, damage: [start_hp[1] - hps[1], start_hp[0] - hps[0]] };
        }
    }
    let hps = [hp(&players, 0), hp(&players, 1)];
    Outcome { winner: None, ticks: max_ticks, damage: [start_hp[1] - hps[1], start_hp[0] - hps[0]] }
}

fn hp(players: &Players, slot: usize) -> f64 {
    players.player(slot).map_or(0.0, |p| p.hp)
}

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("read scenario from stdin");
    let s: Scenario = serde_json::from_str(&text).expect("valid scenario JSON");
    let hz = tuning().sim_hz;
    let max_ticks = (s.max_seconds * hz).round() as u32;

    let mut pairings = Vec::new();
    let mut wins: HashMap<String, (f64, f64)> = HashMap::new(); // name -> (wins, decided)
    for i in 0..s.builds.len() {
        for j in (i + 1)..s.builds.len() {
            let (a, b) = (&s.builds[i], &s.builds[j]);
            let (ba, bb) = (to_build(a), to_build(b));
            let (mut aw, mut bw, mut draws) = (0u32, 0u32, 0u32);
            let (mut ticks, mut decided, mut dmg_a, mut dmg_b) = (0u64, 0u32, 0.0, 0.0);
            for d in 0..s.duels {
                // Each duel is run both ways round, so which side spawns where cannot decide it.
                let flip = d % 2 == 1;
                let seed = s.seed.wrapping_add(d).wrapping_mul(2_654_435_761);
                let o = if flip { duel(&bb, &ba, seed, max_ticks, s.start_distance) } else { duel(&ba, &bb, seed, max_ticks, s.start_distance) };
                let winner = o.winner.map(|w| if flip { 1 - w } else { w });
                let dmg = if flip { [o.damage[1], o.damage[0]] } else { o.damage };
                dmg_a += dmg[0];
                dmg_b += dmg[1];
                match winner {
                    Some(0) => {
                        aw += 1;
                        ticks += o.ticks as u64;
                        decided += 1;
                    }
                    Some(_) => {
                        bw += 1;
                        ticks += o.ticks as u64;
                        decided += 1;
                    }
                    None => draws += 1,
                }
            }
            let rate = if aw + bw > 0 { aw as f64 / (aw + bw) as f64 } else { 0.5 };
            wins.entry(a.name.clone()).or_default().0 += aw as f64;
            wins.entry(a.name.clone()).or_default().1 += (aw + bw) as f64;
            wins.entry(b.name.clone()).or_default().0 += bw as f64;
            wins.entry(b.name.clone()).or_default().1 += (aw + bw) as f64;
            let mean_ticks = if decided > 0 { ticks as f64 / decided as f64 } else { f64::NAN };
            pairings.push(Pairing {
                a: a.name.clone(),
                b: b.name.clone(),
                duels: s.duels,
                a_wins: aw,
                b_wins: bw,
                draws,
                a_win_rate: rate,
                mean_ticks,
                mean_seconds: mean_ticks / hz,
                a_damage: dmg_a / s.duels as f64,
                b_damage: dmg_b / s.duels as f64,
            });
        }
    }
    let mut overall: Vec<(String, f64)> = wins.into_iter().map(|(k, (w, n))| (k, if n > 0.0 { w / n } else { 0.5 })).collect();
    overall.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let report = Report { tick_hz: hz, duels_per_pairing: s.duels, pairings, overall };
    // A table on stderr to read, the JSON on stdout to diff or chart.
    eprintln!("{:<10} {:<10} {:>7} {:>7} {:>8} {:>8} {:>6}", "A", "B", "A win%", "TTK s", "A dmg", "B dmg", "draws");
    for p in &report.pairings {
        let ttk = if p.mean_seconds.is_nan() { "-".to_string() } else { format!("{:.1}", p.mean_seconds) };
        eprintln!("{:<10} {:<10} {:>6.0}% {:>7} {:>8.1} {:>8.1} {:>6}", p.a, p.b, p.a_win_rate * 100.0, ttk, p.a_damage, p.b_damage, p.draws);
    }
    eprintln!("\nwin rate over decided duels:");
    for (name, rate) in &report.overall {
        eprintln!("  {name:<10} {:>5.1}%", rate * 100.0);
    }
    eprintln!(
        "\nBoth sides walk in and swing, so this is the paper matchup, not the played one:\na build that wants to kite or space will read worse here than it plays."
    );
    println!("{}", serde_json::to_string_pretty(&report).expect("serialize"));
}
