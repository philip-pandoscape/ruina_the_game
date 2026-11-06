//! The creatures' check (aicheck, tests/conformance/ai.test.ts): runs behaviours through the rules
//! and gives back every frame.
//!
//! Two kinds of scenario. One brain on its own: `brain`, `seed`, `x`, `z`, `frames`, `player`.
//! A whole pack (`pack` is present): real kinds from shared/actors.json and shared/creatures.json
//! stepped together, with hits landing on whoever stands nearest a point at given frames, so
//! calling, gathering, bursting and reforming all run as they do in a fight. A pack can be given
//! scripted `foes` (players walking back and forth, swinging, dodging) for war-bands to fight; the
//! blows and missiles that reach them come back too.

use serde::{Deserialize, Serialize};

use crate::actor::Actor;
use crate::actors::Actors;
use crate::ai::{Foe, Sighting, start_brain, step_brain};
use crate::jsmath::JsMath;

#[derive(Deserialize)]
struct Spawn {
    kind: String,
    x: f64,
    z: f64,
    seed: u32,
    /// The war-band it fights in, 0 for none.
    #[serde(default)]
    band: u32,
}

#[derive(Deserialize)]
struct Hit {
    frame: usize,
    x: f64,
    z: f64,
    damage: f64,
}

fn one() -> f64 {
    1.0
}

/// A scripted player: walks back and forth between two points, facing a point, swinging and
/// dodging on a beat. Only exact arithmetic (and atan2, which both sides share bit for bit), so
/// the browser works out the very same foe (foeAt in tests/conformance/ai.test.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoeScript {
    id: u32,
    from: [f64; 2],
    to: [f64; 2],
    #[serde(default = "one")]
    period: f64,
    look: [f64; 2],
    #[serde(default)]
    reach: f64,
    #[serde(default)]
    ranged: bool,
    /// [every, swinging for, recovering for] frames; every 0 never swings.
    #[serde(default)]
    swing: [u32; 3],
    /// [every, from, to] frames of a dodge's untouchable window; every 0 never dodges.
    #[serde(default)]
    dodge: [u32; 3],
    #[serde(default = "one")]
    hp: f64,
}

fn foe_at(s: &FoeScript, f: usize) -> Foe {
    let t = (f as f64 % s.period) / s.period;
    let (k, dir) = if t < 0.5 { (2.0 * t, 2.0) } else { (2.0 - 2.0 * t, -2.0) };
    let x = s.from[0] + (s.to[0] - s.from[0]) * k;
    let z = s.from[1] + (s.to[1] - s.from[1]) * k;
    let vx = (s.to[0] - s.from[0]) * dir / s.period * 60.0;
    let vz = (s.to[1] - s.from[1]) * dir / s.period * 60.0;
    let facing = (s.look[0] - x).js_atan2(s.look[1] - z);
    let (mut act, mut invuln) = (0u8, false);
    if s.swing[0] > 0 {
        let c = f as u32 % s.swing[0];
        if c < s.swing[1] {
            act = 1;
        } else if c < s.swing[1] + s.swing[2] {
            act = 2;
        }
    }
    if act == 0 && s.dodge[0] > 0 {
        let c = f as u32 % s.dodge[0];
        if c >= s.dodge[1] && c < s.dodge[2] {
            act = 5;
            invuln = true;
        }
    }
    Foe { id: s.id, x, y: 0.0, z, vx, vz, facing, hp: s.hp, reach: s.reach, ranged: s.ranged, act, invuln, air: 0.0 }
}

#[derive(Deserialize)]
struct Scenario {
    #[serde(default)]
    brain: String,
    #[serde(default)]
    seed: u32,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    z: f64,
    frames: usize,
    /// Whether a player is in the world at all; a brain with nobody to notice just wanders.
    #[serde(default)]
    player: bool,
    #[serde(default)]
    pack: Option<Vec<Spawn>>,
    #[serde(default)]
    hits: Vec<Hit>,
    #[serde(default)]
    foes: Option<Vec<FoeScript>>,
}

#[derive(Serialize)]
struct Out {
    frames: Vec<[f64; 9]>,
}

const ROW: usize = 35;

#[derive(Serialize)]
struct PackOut {
    /// Per frame, per actor: see `row`.
    frames: Vec<Vec<Vec<f64>>>,
    /// Per frame, the slams that landed: [x, z, radius, damage].
    slams: Vec<Vec<[f64; 4]>>,
    /// Per frame, blows and missiles that reached a foe: [foe, damage, nx, nz, knock].
    hits: Vec<Vec<[f64; 5]>>,
    /// Per frame, everything in flight: [id, x, y, z, vy].
    missiles: Vec<Vec<[f64; 5]>>,
}

/// A path both sides can work out for themselves, so the scenario stays small.
fn player_at(f: usize) -> (f64, f64) {
    let t = f as f64;
    ((t / 90.0).js_sin() * 4.0, (t / 70.0).js_cos() * 4.0 - 1.0)
}

fn b(v: bool) -> f64 {
    if v { 1.0 } else { 0.0 }
}

fn row(a: &Actor) -> Vec<f64> {
    let r = vec![
        a.id as f64,
        a.kind_index as f64,
        a.x,
        a.y,
        a.z,
        a.facing,
        a.state as f64,
        a.state_frame as f64,
        a.wait as f64,
        a.hp,
        a.mass,
        a.dead_frame as f64,
        a.angry as f64,
        a.rally_to as f64,
        a.calling as f64,
        a.fuse as f64,
        a.group as f64,
        b(a.gone),
        a.pulled as f64,
        a.stride,
        a.target as f64,
        a.band as f64,
        b(a.token),
        b(a.opening),
        b(a.afraid),
        a.slot_x,
        a.slot_z,
        a.rally_x,
        a.rally_z,
        a.dest_x,
        a.dest_z,
        a.charges as f64,
        a.cds[0] as f64,
        a.cds[1] as f64,
        b(a.struck),
    ];
    debug_assert_eq!(r.len(), ROW);
    r
}

fn run_pack(s: &Scenario, spawns: &[Spawn]) -> PackOut {
    let mut actors = Actors::new();
    for p in spawns {
        if p.band != 0 {
            actors.spawn_in_band(&p.kind, p.x, p.z, 0.0, p.seed, p.band);
        } else {
            actors.spawn(&p.kind, p.x, p.z, p.seed);
        }
    }
    let mut out = PackOut { frames: Vec::with_capacity(s.frames), slams: Vec::new(), hits: Vec::new(), missiles: Vec::new() };
    for f in 0..s.frames {
        let foes: Vec<Foe> = match &s.foes {
            Some(list) => list.iter().map(|fs| foe_at(fs, f)).collect(),
            None => {
                let (px, pz) = player_at(f);
                vec![Foe { id: 1, x: px, z: pz, hp: 1.0, ..Foe::default() }]
            }
        };
        let (px, pz) = (foes[0].x, foes[0].z);
        for h in s.hits.iter().filter(|h| h.frame == f) {
            // Whoever is standing nearest the point takes it, struck from where the first foe is.
            let mut best: Option<(f64, u32, f64, f64)> = None;
            for a in actors.list.iter().filter(|a| a.is_alive() && !a.gone) {
                let (hx, hz) = (a.x - h.x, a.z - h.z);
                let d = (hx * hx + hz * hz).sqrt();
                if best.is_none_or(|(bd, ..)| d < bd) {
                    best = Some((d, a.id, a.x, a.z));
                }
            }
            if let Some((_, id, ax, az)) = best {
                let (dx, dz) = (ax - px, az - pz);
                let d = (dx * dx + dz * dz).sqrt().max(1e-6);
                actors.damage(id, h.damage, dx / d, dz / d, 0.0);
            }
        }
        let done = actors.step(&foes, &|_, _| 0.0, 140.0, 7.0, 1.0 / 60.0);
        out.frames.push(actors.list.iter().map(row).collect());
        out.slams.push(done.slams.iter().map(|s| [s.x, s.z, s.radius, s.damage]).collect());
        out.hits.push(done.hits.iter().map(|h| [h.foe as f64, h.damage, h.nx, h.nz, h.knock]).collect());
        out.missiles.push(actors.missiles.iter().map(|m| [m.id as f64, m.x, m.y, m.z, m.vy]).collect());
    }
    out
}

/// Runs a scenario (JSON, as the conformance test writes it) and gives back every frame (JSON).
pub fn run(input: &str) -> serde_json::Result<String> {
    let s: Scenario = serde_json::from_str(input)?;
    if let Some(spawns) = &s.pack {
        return serde_json::to_string(&run_pack(&s, spawns));
    }

    let mut a = Actor::new(1, "test", s.x, s.z, s.seed);
    a.brain = Some(s.brain.clone());
    let seen0 = {
        let (px, pz) = player_at(0);
        Sighting::at(px, pz, s.player)
    };
    start_brain(&mut a, seen0);

    let mut frames = Vec::with_capacity(s.frames);
    for f in 0..s.frames {
        let (px, pz) = player_at(f);
        step_brain(&mut a, Sighting::at(px, pz, s.player));
        frames.push([a.x, a.y, a.z, a.facing, a.state as f64, a.state_frame as f64, a.wait as f64, a.move_x, a.move_z]);
    }
    serde_json::to_string(&Out { frames })
}
