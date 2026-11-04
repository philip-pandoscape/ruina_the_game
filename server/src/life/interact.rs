//! What pressing F does right now, and the commands everything else sends
//! (src/sim/life/interact.ts). The focus is worked out from what is near you and in front of you,
//! so the prompt on screen is always exactly what the next press will do.

use std::collections::HashSet;
use std::f64::consts::PI;

use super::content::{
    animal_def, blueprint_def, carry, crop_def, design_for_item, format_coins, gathering, item_def, js_max, js_min, js_round, pack_def, place_name, quest_def, recipe as recipe_by_id,
    rideable, ship_design, structure_def, QuestDef, QuestStep,
};
use super::contracts::accept_contract;
use super::farming::{add_scarecrow, cell_at, cell_centre, fell, grow_for, harvest, is_ripe, plant, plant_at, plot_problem, scarecrow_index, seconds_to_ripe, stage_of, water};
use super::housing::{build_stage, deliver_material, house_on, house_pose, interior_point, is_complete, pay_tax, place_house, stage_ready, still_needs, tax_due, Need, DAY};
use super::livestock::{collect, feed, grown_up, hungry, produce_ready, raise};
use super::quests::{accept, complete, quests_at};
use super::shipyard::{build_ship_stage, deliver_ship_material, design_items_in_bag, launch, lay_keel, ship_finished, ship_needs, ship_on, ship_stage_ready};
use super::state::{Home, Stack};
use super::trade::{buy, carried, drop_pack, load_pack, pack_index, pick_up, quote, recover_demand, run_recipe, sell, sell_pack, unload_pack};
use super::vehicles::{board, dismount, distance_to, mount_command, nearest_anchor, recall, ridden, summon, vehicle_index};
use super::{Command, Focus, Life, LifeEvent, Placement, QuestEvent};
use crate::open::traverse::{close_glider, glider_blocked, gust, open_glider};
use crate::open::zone::{to_local, Outpost, Zone};
use crate::open::Sim;
use crate::player::Mode;

fn outpost_of(life: &Life, npc: &str) -> Option<&'static Outpost> {
    let zone: &'static Zone = life.zone;
    zone.recipe.outposts.iter().find(|o| o.npc == npc)
}

pub fn node_ready(life: &Life, i: usize) -> bool {
    life.state.nodes.get(&i.to_string()).copied().unwrap_or(0.0) <= life.state.clock
}

/// Seconds left on something, as "1m 20s".
pub fn short_time(s: f64) -> String {
    let s = js_max(0.0, s.ceil());
    if s >= DAY {
        return format!("{}d {}h", num((s / DAY).floor()), num(((s % DAY) / 3600.0).floor()));
    }
    if s >= 3600.0 {
        return format!("{}h {}m", num((s / 3600.0).floor()), num(((s % 3600.0) / 60.0).floor()));
    }
    if s >= 60.0 {
        return format!("{}m {}s", num((s / 60.0).floor()), num(s % 60.0));
    }
    format!("{}s", num(s))
}

/// A number the way JavaScript writes it into a string (`${x}`).
fn num(x: f64) -> String {
    if x == 0.0 {
        "0".into() // -0 too
    } else if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if x.abs() >= 1e21 {
        format!("{x:e}").replace('e', "e+")
    } else if x.abs() < 1e-6 {
        format!("{x:e}")
    } else {
        format!("{x}")
    }
}

/// A number the way JavaScript tests it in an `if`: anything but 0 and NaN.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// An optional string the way JavaScript tests it in an `if`: there, and not empty.
fn has(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

fn quest_step(q: &QuestDef, step: i64) -> Option<&QuestStep> {
    usize::try_from(step).ok().and_then(|i| q.steps.get(i))
}

/// "Lumber Bundle 1/2 · Stone Block 0/2": what a stage still needs, for the prompt.
fn needs_list(needs: &[Need]) -> String {
    needs.iter().map(|n| format!("{} {}/{}", pack_def(&n.pack).name, n.have, n.need)).collect::<Vec<_>>().join(" · ")
}

/// The seed F plants: the one you chose while you have any left, else the first in your bag.
fn chosen_seed(life: &Life) -> Option<String> {
    let seed = &life.state.seed;
    if !seed.is_empty() && life.count(seed) > 0 {
        return Some(seed.clone());
    }
    life.state.bag.iter().find(|s| item_def(&s.item).cat == "seed").map(|s| s.item.clone()).filter(|s| !s.is_empty())
}

// ---------- Working out the focus ----------

/// The best of what is around you: near, and in front of you.
struct Pick {
    x: f64,
    z: f64,
    fx: f64,
    fz: f64,
    best: Option<Focus>,
    score: f64,
}

impl Pick {
    fn consider(&mut self, f: Focus, dist: f64, range: f64) {
        if dist > range {
            return;
        }
        let dx = f.x - self.x;
        let dz = f.z - self.z;
        let l = dx.hypot(dz);
        let facing = if l > 0.3 { (dx * self.fx + dz * self.fz) / l } else { 1.0 };
        let score = dist + (1.0 - facing) * 1.2;
        if score < self.score {
            self.score = score;
            self.best = Some(f);
        }
    }
}

/// What pressing F would do right now. While a scarecrow is being placed, this also moves it to
/// the spot in front of you.
pub fn find_focus(life: &mut Life, sim: &Sim) -> Option<Focus> {
    let p = &*sim.player;
    let hf = sim.terrain();
    if p.mode == Mode::Ride {
        let mount = ridden(life, sim).is_some_and(|i| rideable(&life.state.vehicles[i].def).is_mount());
        return Some(Focus { action: "exit".into(), key: "exit".into(), label: if mount { "Dismount" } else { "Get out" }.into(), ok: true, x: p.pos.x, y: p.pos.y, z: p.pos.z, ..Default::default() });
    }
    if life.placing.is_some() {
        let ahead = 7.0;
        let x = p.pos.x + p.facing.sin() * ahead;
        let z = p.pos.z + p.facing.cos() * ahead;
        let rot = js_round(p.facing / (PI / 12.0)) * (PI / 12.0);
        let problem = plot_problem(life, sim, x, z, rot);
        if let Some(pl) = life.placing.as_mut() {
            pl.x = x;
            pl.z = z;
            pl.rot = rot;
            pl.problem = problem.clone();
        }
        let ok = problem.is_none();
        return Some(Focus {
            action: "placeScarecrow".into(),
            key: "place".into(),
            label: problem.unwrap_or_else(|| "Place scarecrow here".into()),
            detail: Some("Esc to cancel".into()),
            ok,
            x,
            y: hf.height(x, z),
            z,
            ..Default::default()
        });
    }
    if p.mode != Mode::Normal && p.mode != Mode::Swim {
        return None;
    }

    let life: &Life = life;
    let zone: &'static Zone = life.zone;
    let (px, pz) = (p.pos.x, p.pos.z);
    let fx = p.facing.sin();
    let fz = p.facing.cos();
    let mut pick = Pick { x: px, z: pz, fx, fz, best: None, score: f64::INFINITY };
    let back = carried(life, sim).map(|i| &life.state.packs[i]);

    // People.
    for n in &zone.recipe.npcs {
        let d = (n.x - px).hypot(n.z - pz);
        if d > 4.0 {
            continue;
        }
        let y = hf.height(n.x, n.z);
        let at = |action: &str, label: String, detail: String, ok: bool| Focus { action: action.into(), key: format!("npc:{}", n.id), label, detail: Some(detail), ok, npc: Some(n.id.clone()), x: n.x, y, z: n.z, ..Default::default() };
        if let (Some(outpost), Some(back)) = (outpost_of(life, &n.id), back) {
            let def = pack_def(&back.def);
            let f = match quote(life, back, &outpost.id) {
                Some(q) => {
                    let seals = if truthy(q.seals) { format!(" + {} seal{}", num(q.seals), if q.seals > 1.0 { "s" } else { "" }) } else { String::new() };
                    let fresh = if q.fresh >= 1.0 { "fresh" } else { "stale" };
                    let detail = format!("{}{seals} · demand {}% · {fresh} {}%", format_coins(q.coins), num(js_round(q.demand * 100.0)), num(js_round((q.fresh - 1.0) * 100.0)));
                    at("sell", format!("Sell {}", def.name), detail, true)
                }
                None => {
                    let why = if back.origin == outpost.id {
                        "Made here - sell it elsewhere"
                    } else if def.kind.as_deref() == Some("material") {
                        "Building materials go to a building site"
                    } else {
                        ""
                    };
                    at("info", format!("{} won't buy that here", n.name), why.into(), false)
                }
            };
            pick.consider(f, d, 4.0);
            continue;
        }
        let (offer, turn_in) = quests_at(life, &n.id);
        let talk_goal = life
            .state
            .quests
            .active
            .iter()
            .any(|qp| quest_step(quest_def(&qp.id), qp.step).is_some_and(|st| st.objectives.iter().any(|o| o.type_ == "talk" && o.npc.as_deref() == Some(n.id.as_str()))));
        let tag = if !turn_in.is_empty() {
            "quest complete!"
        } else if talk_goal {
            "quest"
        } else if !offer.is_empty() {
            "new quest"
        } else {
            n.title.as_str()
        };
        pick.consider(at("talk", format!("Talk to {}", n.name), tag.into(), true), d, 4.0);
    }

    // Workbenches.
    for b in &zone.recipe.workbenches {
        let d = (b.x - px).hypot(b.z - pz);
        let name = b.name.as_deref().unwrap_or("Workbench");
        let detail = if back.is_some() { "Your back is full".into() } else { format!("{} packs", place_name(&b.place)) };
        let f = Focus { action: "craft".into(), key: format!("bench:{}", b.id), label: format!("Use {name}"), detail: Some(detail), ok: true, bench: Some(b.id.clone()), x: b.x, y: hf.height(b.x, b.z), z: b.z, ..Default::default() };
        pick.consider(f, d, 3.4);
    }

    // Packs lying on the ground.
    if back.is_none() {
        for pk in &life.state.packs {
            if pk.at != "ground" {
                continue;
            }
            let d = (pk.x - px).hypot(pk.z - pz);
            let f = Focus { action: "pickup".into(), key: format!("pack:{}", pk.id), label: format!("Pick up {}", pack_def(&pk.def).name), ok: true, pack: Some(pk.id), x: pk.x, y: pk.y, z: pk.z, ..Default::default() };
            pick.consider(f, d, carry().pickup_range);
        }
    }

    // Vehicles: the seat to get in, the cargo bed to load or unload.
    for v in &life.state.vehicles {
        let d = distance_to(v, px, pz);
        if d > 2.2 {
            continue;
        }
        let def = rideable(&v.def);
        let a = nearest_anchor(v, px, pz, back.is_some());
        let free = v.cargo.iter().position(|&c| c == 0);
        let loaded = v.cargo.iter().position(|&c| c != 0);
        let used = v.cargo.iter().filter(|&&c| c != 0).count();
        let slots = def.cargo.len();
        let at = |action: &str, key: String, label: String, detail: Option<String>, ok: bool| Focus { action: action.into(), key, label, detail, ok, vehicle: Some(v.id), x: v.x, y: v.y, z: v.z, ..Default::default() };
        let load = if a.kind == "cargo" && slots > 0 { back.zip(free) } else { None };
        let unload = if a.kind == "cargo" && back.is_none() { loaded } else { None };
        if let Some((back, free)) = load {
            let f = at("load", format!("veh:{}:load", v.id), format!("Load {}", pack_def(&back.def).name), Some(format!("{} {used}/{slots}", def.name)), true);
            pick.consider(Focus { slot: Some(free as i64), ..f }, d, 2.2);
        } else if let Some(loaded) = unload {
            let f = at("unload", format!("veh:{}:unload", v.id), format!("Take a pack from the {}", def.name), Some(format!("{used}/{slots} aboard")), true);
            pick.consider(Focus { slot: Some(loaded as i64), ..f }, d, 2.2);
        } else {
            let mount = def.is_mount();
            let blocked = mount && back.is_some() && !def.can_carry_pack;
            let detail = if blocked {
                Some("Will not carry a pack".into())
            } else if slots > 0 {
                Some(format!("cargo {used}/{slots}"))
            } else {
                None
            };
            pick.consider(at("board", format!("veh:{}", v.id), format!("{} {}", if mount { "Ride" } else { "Drive" }, def.name), detail, !blocked), d + 0.3, 2.2);
        }
    }

    // Your farm plots: whatever is in the cell in front of you.
    let tx = px + fx * 1.3;
    let tz = pz + fz * 1.3;
    if let Some((k, idx)) = cell_at(life, tx, tz) {
        let sc = &life.state.scarecrows[k];
        let here = sc.cells.get(idx).and_then(|c| c.as_ref());
        let (cx, cz) = cell_centre(sc, idx);
        let y = hf.height(cx, cz);
        let at = |action: &str, label: String, detail: String, ok: bool| Focus {
            action: action.into(),
            key: format!("cell:{}:{idx}", sc.id),
            label,
            detail: Some(detail),
            ok,
            sc: Some(sc.id),
            cell: Some(idx as i64),
            x: cx,
            y,
            z: cz,
            ..Default::default()
        };
        match here {
            None => match chosen_seed(life) {
                Some(seed) => {
                    let def = item_def(&seed);
                    let verb = if has(&def.raises) { "Raise" } else { "Plant" };
                    let what = def.name.replacen(" Seeds", "", 1).replacen(" Sapling", " sapling", 1);
                    pick.consider(at("plant", format!("{verb} {what}"), format!("{} left · Z: change seed", life.count(&seed)), true), 0.5, 9.0);
                }
                None => pick.consider(at("info", "Empty soil".into(), "Buy seeds from Mara, or young animals from Sela".into(), false), 0.5, 9.0),
            },
            Some(plant) if plant.is_animal() => {
                let def = animal_def(&plant.crop);
                let name = if grown_up(plant) { &def.name } else { &def.young };
                let fed = life.count(&def.feed) >= def.feed_n;
                if produce_ready(plant) {
                    pick.consider(at("collect", def.verb.clone(), format!("{} labor", num(def.collect_labor)), true), 0.5, 9.0);
                } else if hungry(life, plant) {
                    pick.consider(at("feed", format!("Feed the {}", name.to_lowercase()), format!("{} {} · hungry", def.feed_n, item_def(&def.feed).name), fed), 0.5, 9.0);
                } else {
                    let left = js_max(0.0, (plant.fed_until.unwrap_or(0.0) - life.state.clock).ceil());
                    let state = if grown_up(plant) {
                        format!("{} {}%", def.produce, num(js_round(plant.produce.unwrap_or(0.0) * 100.0)))
                    } else {
                        format!("growing {}%", num(js_round(plant.growth * 100.0)))
                    };
                    pick.consider(at("feed", format!("Feed the {}", name.to_lowercase()), format!("{state} · fed for {}", short_time(left)), fed), 0.5, 9.0);
                }
            }
            Some(plant) => {
                let def = crop_def(&plant.crop);
                let stage = stage_of(plant);
                let pct = num(js_round(plant.growth * 100.0));
                if is_ripe(plant) && has(&def.produce) {
                    pick.consider(at("harvest", format!("Harvest {}", def.name), format!("{} labor", num(def.harvest_labor)), true), 0.5, 9.0);
                } else if let Some(chop) = def.chop.as_ref().filter(|_| stage >= def.stages - 2) {
                    pick.consider(at("fell", format!("Fell {}", def.name), format!("{} labor · timber", num(chop.labor)), true), 0.5, 9.0);
                } else if !plant.watered && plant.growth < 1.0 {
                    pick.consider(at("water", format!("Water {}", def.name), format!("{pct}% · ripe in ~{}", short_time(seconds_to_ripe(life, plant))), true), 0.5, 9.0);
                } else {
                    let watered = if plant.watered { "watered · " } else { "" };
                    pick.consider(at("info", format!("{} - {pct}%", def.name), format!("{watered}ripe in ~{}", short_time(seconds_to_ripe(life, plant))), false), 0.5, 9.0);
                }
            }
        }
    }

    // Gathering: timber, stone, ore, herbs.
    for (i, nd) in zone.recipe.nodes.iter().enumerate() {
        let Some(y) = gathering().get(&nd.kind) else { continue };
        let sd = structure_def(&nd.kind);
        let d = js_max(0.0, (nd.x - px).hypot(nd.z - pz) - sd.w / 2.0);
        if d > 2.0 {
            continue;
        }
        let ready = node_ready(life, i);
        let (label, detail) = if ready {
            (y.verb.clone(), format!("{} labor", num(y.labor)))
        } else {
            // A node is only on cooldown once it has a time to come back at.
            let back_at = life.state.nodes.get(&i.to_string()).copied().unwrap_or(f64::NAN);
            (format!("{} - picked clean", sd.name), format!("back in {}", short_time(back_at - life.state.clock)))
        };
        let f = Focus { action: if ready { "gather" } else { "info" }.into(), key: format!("node:{i}"), label, detail: Some(detail), ok: ready, node: Some(i as i64), x: nd.x, y: hf.height(nd.x, nd.z), z: nd.z, ..Default::default() };
        pick.consider(f, d, 2.0);
    }

    // Slipways: lay a keel, haul materials, build, launch.
    for sy in &zone.recipe.shipyards {
        let d = (sy.x - px).hypot(sy.z - pz);
        if d > 12.0 {
            continue;
        }
        let y = hf.height(sy.x, sy.z);
        let at = |action: &str, label: String, detail: Option<String>, ok: bool| Focus { action: action.into(), key: format!("slip:{}", sy.id), label, detail, ok, slip: Some(sy.id.clone()), x: sy.x, y, z: sy.z, ..Default::default() };
        let score = d * 0.3 + 1.2;
        let Some(bi) = ship_on(life, &sy.id) else {
            let f = match design_items_in_bag(life).into_iter().next() {
                Some(design) => at("keel", format!("Lay the {}'s keel", design_for_item(&design).map_or("", |d| d.name.as_str())), Some(sy.name.clone()), true),
                None => at("info", sy.name.clone(), Some("Needs a ship design - Captain Ilsa sells them".into()), false),
            };
            pick.consider(f, score, 12.0);
            continue;
        };
        let b = &life.state.ships[bi];
        let design = ship_design(&b.design);
        if ship_finished(b) {
            pick.consider(at("launch", format!("Launch the {}", design.name), None, true), score, 12.0);
            continue;
        }
        // (A stage that isn't there is a ship the TypeScript can't show either.)
        let Some(stage) = usize::try_from(b.stage).ok().and_then(|s| design.stages.get(s)) else { continue };
        let needs = ship_needs(b);
        let list = needs_list(&needs);
        if ship_stage_ready(b) {
            pick.consider(at("shipBuild", format!("Build the {}", stage.name.to_lowercase()), Some(format!("{} labor", num(stage.labor))), true), score, 12.0);
        } else if let Some(back) = back.filter(|bk| needs.iter().any(|n| n.pack == bk.def && n.have < n.need)) {
            pick.consider(at("shipDeliver", format!("Deliver {}", pack_def(&back.def).name), Some(format!("{}: {list}", stage.name)), true), score, 12.0);
        } else {
            pick.consider(at("info", format!("{}: {} needs", design.name, stage.name), Some(list), false), score, 12.0);
        }
    }

    // House plots and building sites.
    for plot in &zone.recipe.house_plots {
        let (lx, lz) = to_local(px - plot.x, pz - plot.z, plot.rot);
        if lx.abs() > 9.0 || lz.abs() > 9.0 {
            continue;
        }
        let h = house_on(life, &plot.id).map(|i| &life.state.houses[i]);
        let y = hf.height(plot.x, plot.z);
        let d = lx.hypot(lz) * 0.25 + 1.5;
        let owner = if h.is_some() { None } else { life.plot_owners.get(&plot.id).filter(|o| !o.is_empty()) };
        let on_plot = |action: &str, label: String, detail: &str, ok: bool| Focus { action: action.into(), key: format!("plot:{}", plot.id), label, detail: Some(detail.into()), ok, plot: Some(plot.id.clone()), x: plot.x, y, z: plot.z, ..Default::default() };
        if let Some(owner) = owner {
            pick.consider(on_plot("info", format!("{owner}'s plot"), "Already claimed", false), d, 9.0);
            continue;
        }
        let Some(h) = h else {
            let f = match life.state.bag.iter().find(|s| s.item.starts_with("blueprint.")) {
                Some(bp) => on_plot("claim", format!("Place {}", item_def(&bp.item).name), "Claims this plot", true),
                None => on_plot("info", "Plot for claim".into(), "Needs a Cottage Blueprint - Land Registry", false),
            };
            pick.consider(f, d, 9.0);
            continue;
        };
        let (hx, hz, _) = house_pose(life, h);
        if !is_complete(h) {
            let bp = blueprint_def(&h.blueprint);
            // (A stage that isn't there is a house the TypeScript can't show either.)
            let Some(stage) = usize::try_from(h.stage).ok().and_then(|s| bp.stages.get(s)) else { continue };
            let needs = still_needs(h);
            let list = needs_list(&needs);
            let site = |action: &str, label: String, detail: String, ok: bool| Focus { action: action.into(), key: format!("site:{}", h.id), label, detail: Some(detail), ok, house: Some(h.id), x: hx, y, z: hz, ..Default::default() };
            if stage_ready(h) {
                pick.consider(site("build", format!("Build the {}", stage.name.to_lowercase()), format!("{} labor", num(stage.labor)), true), d, 9.0);
            } else if let Some(back) = back.filter(|bk| needs.iter().any(|n| n.pack == bk.def && n.have < n.need)) {
                pick.consider(site("deliver", format!("Deliver {}", pack_def(&back.def).name), format!("{}: {list}", stage.name), true), d, 9.0);
            } else {
                pick.consider(site("info", format!("{} needs", stage.name), list, false), d, 9.0);
            }
            continue;
        }
        for what in ["bed", "chest"] {
            let (ix, iz) = interior_point(life, h, what);
            let dd = (ix - px).hypot(iz - pz);
            let f = if what == "bed" {
                Focus { action: "rest".into(), key: format!("bed:{}", h.id), label: "Rest in bed".into(), detail: Some("Labor recovers 3× faster".into()), ok: true, house: Some(h.id), x: ix, y: y + 0.3, z: iz, ..Default::default() }
            } else {
                Focus { action: "storage".into(), key: format!("chest:{}", h.id), label: "Open storage chest".into(), ok: true, house: Some(h.id), x: ix, y: y + 0.3, z: iz, ..Default::default() }
            };
            pick.consider(f, dd, 1.8);
        }
        let (owed, due_in) = tax_due(life, h);
        if lz.abs() > 5.0 {
            let detail = if due_in > 0.0 { format!("paid for {}", short_time(due_in)) } else { "OVERDUE".into() };
            let f = Focus { action: "tax".into(), key: format!("tax:{}", h.id), label: format!("Pay property tax ({})", format_coins(owed)), detail: Some(detail), ok: true, house: Some(h.id), x: plot.x, y, z: plot.z, ..Default::default() };
            pick.consider(f, d + 1.0, 9.0);
        }
    }
    pick.best
}

// ---------- Commands ----------

fn near_npc(life: &Life, sim: &Sim, npc: &str, range: f64) -> bool {
    let zone: &'static Zone = life.zone;
    zone.recipe.npcs.iter().find(|x| x.id == npc).is_some_and(|n| (n.x - sim.player.pos.x).hypot(n.z - sim.player.pos.z) <= range)
}

fn house_index(life: &Life, id: i64) -> Option<usize> {
    life.state.houses.iter().position(|x| x.id == id)
}

pub fn run_command(life: &mut Life, sim: &mut Sim, c: &Command) {
    match c {
        Command::Interact => interact(life, sim),
        Command::Drop => {
            if !drop_pack(life, sim) && sim.player.pack == 0 {
                life.toast("You are not carrying a pack", "info");
            }
        }
        Command::Mount => mount_command(life, sim),
        Command::Exit => {
            dismount(life, sim);
        }
        Command::Gust => {
            if !gust(sim) && sim.player.mode == Mode::Glide {
                life.toast("The wing is still recovering", "info");
            }
        }
        Command::Glider => {
            if sim.player.mode == Mode::Glide {
                close_glider(sim, "fold");
                return;
            }
            match glider_blocked(sim) {
                Some(why) => life.toast(why, "bad"),
                None => {
                    open_glider(sim);
                }
            }
        }
        Command::CycleSeed => {
            let bag = &life.state.bag;
            let seeds: Vec<String> = bag
                .iter()
                .enumerate()
                .filter(|&(k, s)| item_def(&s.item).cat == "seed" && bag.iter().position(|x| x.item == s.item) == Some(k))
                .map(|(_, s)| s.item.clone())
                .collect();
            if seeds.is_empty() {
                return;
            }
            let next = seeds.iter().position(|s| *s == life.state.seed).map_or(0, |i| (i + 1) % seeds.len());
            life.state.seed = seeds[next].clone();
            life.toast(format!("Planting {}", item_def(&life.state.seed).name), "info");
        }
        Command::Use { item } => use_item(life, sim, item),
        Command::Buy { npc, item, n } => {
            if near_npc(life, sim, npc, 6.0) {
                buy(life, npc, item, *n);
            }
        }
        Command::Sell { npc, item, n } => {
            if near_npc(life, sim, npc, 6.0) {
                sell(life, npc, item, *n);
            }
        }
        Command::Craft { recipe } => {
            // You have to be at the bench, or with the crafter, to use their recipes.
            let Some(r) = recipe_by_id(recipe) else { return };
            let zone: &'static Zone = life.zone;
            let near = match zone.recipe.workbenches.iter().find(|b| b.id == r.bench) {
                Some(bench) => (bench.x - sim.player.pos.x).hypot(bench.z - sim.player.pos.z) <= 6.0,
                None => near_npc(life, sim, &r.bench, 6.0),
            };
            if !near {
                life.toast("Too far from the workbench", "bad");
                return;
            }
            run_recipe(life, sim, recipe);
        }
        Command::Accept { quest } => {
            accept(life, quest);
        }
        Command::Contract { id } => {
            let zone: &'static Zone = life.zone;
            let k = life.state.contracts.as_ref().and_then(|cs| cs.offered.iter().find(|x| x.id == *id));
            let post = k.and_then(|k| zone.recipe.outposts.iter().find(|o| o.id == k.outpost));
            if post.is_some_and(|post| near_npc(life, sim, &post.npc, 6.0)) {
                accept_contract(life, *id);
            }
        }
        Command::Complete { quest } => {
            complete(life, quest);
        }
        Command::Summon { item } => {
            summon(life, sim, item);
        }
        Command::Recall { vehicle } => {
            if recall(life, sim, *vehicle, false) {
                life.toast("Sent home", "info");
            }
        }
        Command::CancelPlace => life.placing = None,
        Command::Store { house, item, n } => store_or_take(life, true, *house, item, *n),
        Command::Take { house, item, n } => store_or_take(life, false, *house, item, *n),
        Command::PayTax { house } => {
            if house_index(life, *house).is_some() {
                pay_tax(life, *house);
            }
        }
        Command::Rest => life.resting = true,
        Command::Grant { item, n, coins, seals, labor } => {
            if let Some(item) = item.as_deref().filter(|i| !i.is_empty()) {
                life.give(item, n.unwrap_or(1), false);
            }
            if let Some(coins) = coins.filter(|&c| truthy(c)) {
                life.state.coins += coins;
            }
            if let Some(seals) = seals.filter(|&s| truthy(s)) {
                life.state.seals += seals;
            }
            if let Some(labor) = labor.filter(|&l| truthy(l)) {
                life.state.labor = js_min(1000.0, life.state.labor + labor);
            }
        }
        Command::Warp { seconds } => {
            let seconds = *seconds;
            life.state.clock += seconds;
            grow_for(life, seconds);
            recover_demand(life, seconds);
            life.regen_labor(seconds, false, false);
        }
        // The channel moves you itself (server/src/world_game.rs); it never reaches an island.
        Command::Teleport { .. } => {}
    }
}

/// Puts things from your bag into a finished house's chest (store), or back (take).
fn store_or_take(life: &mut Life, store: bool, house: i64, item: &str, n: i64) {
    // Only a real count moves anything: a negative one would make items out of nothing.
    if n <= 0 {
        return;
    }
    let Some(hi) = house_index(life, house) else { return };
    if !is_complete(&life.state.houses[hi]) {
        return;
    }
    let bp = blueprint_def(&life.state.houses[hi].blueprint);
    if store {
        let n = n.min(life.count(item));
        let slots: HashSet<&str> = life.state.houses[hi].storage.iter().map(|s| s.item.as_str()).collect();
        if n == 0 || (!slots.contains(item) && slots.len() >= bp.perks.storage_slots) {
            return;
        }
        life.take(item, n);
        let h = &mut life.state.houses[hi];
        // (Saturating: a count no browser sends must not overflow; the TypeScript's are doubles.)
        match h.storage.iter_mut().find(|x| x.item == item) {
            Some(s) => s.n = s.n.saturating_add(n),
            None => h.storage.push(Stack { item: item.to_string(), n }),
        }
    } else {
        let Some(si) = life.state.houses[hi].storage.iter().position(|x| x.item == item) else { return };
        let n = n.min(life.state.houses[hi].storage[si].n);
        let left = life.give(item, n, true);
        let s = &mut life.state.houses[hi].storage[si];
        s.n = s.n.saturating_sub(n.saturating_sub(left));
        if s.n <= 0 {
            life.state.houses[hi].storage.remove(si);
        }
    }
    life.revision += 1;
}

fn use_item(life: &mut Life, sim: &mut Sim, item: &str) {
    if life.count(item) < 1 {
        return;
    }
    let def = item_def(item);
    match def.cat.as_str() {
        "seed" => {
            life.state.seed = item.to_string();
            life.toast(format!("F plants {} now", def.name), "info");
        }
        "placeable" => match def.places.as_deref() {
            Some("scarecrow") => {
                life.placing = Some(Placement { item: item.to_string(), x: 0.0, z: 0.0, rot: 0.0, problem: None });
                life.toast("Walk to open, level ground and press F to place. Esc cancels.", "info");
            }
            Some("cog") => life.toast("Take it to the Lanternwick slipway beside the shipwright and press F there", "info"),
            _ => life.toast("Take it to an empty plot at Hearthside Rise and press F there", "info"),
        },
        "glider" => {
            let glider = def.glider.clone().unwrap_or_default();
            life.state.glider = glider.clone();
            sim.player.glider = glider;
            life.toast(format!("{} equipped", def.name), "good");
        }
        "deed" | "mount" => {
            if def.cat == "mount" {
                mount_command(life, sim);
                return;
            }
            summon(life, sim, item);
        }
        "consumable" => {
            if let Some(labor) = def.use_.as_ref().and_then(|u| u.labor).filter(|&l| truthy(l)) {
                life.take(item, 1);
                life.state.labor = js_min(1000.0, life.state.labor + labor);
                life.toast(format!("+{} labor", num(labor)), "good");
            }
        }
        _ => {}
    }
}

fn interact(life: &mut Life, sim: &mut Sim) {
    // Worked out afresh: the press acts on what is in front of you now, not a frame ago.
    let f = find_focus(life, sim);
    life.focus = f.clone();
    let Some(f) = f else { return };
    if !f.ok && f.action != "info" {
        return;
    }
    // Cells and slots come from the focus just worked out, so they are in range; anything else
    // finds nothing there.
    let cell = f.cell.and_then(|c| usize::try_from(c).ok()).unwrap_or(usize::MAX);
    let slot = f.slot.and_then(|s| usize::try_from(s).ok()).unwrap_or(usize::MAX);
    let sc = f.sc.filter(|&id| scarecrow_index(life, id).is_some());
    let house = f.house.filter(|&id| house_index(life, id).is_some());
    let vehicle = f.vehicle.filter(|&id| vehicle_index(life, id).is_some());
    let slip = f.slip.clone().unwrap_or_default();
    match f.action.as_str() {
        "talk" => {
            life.notify(QuestEvent { npc: f.npc.clone(), ..QuestEvent::new("talk") });
            life.emit(LifeEvent::Open { ui: "dialog".into(), id: f.npc.clone().unwrap_or_default() });
        }
        "sell" => {
            if let Some(outpost) = f.npc.as_deref().and_then(|npc| outpost_of(life, npc)) {
                sell_pack(life, sim, &outpost.id);
            }
        }
        "craft" => life.emit(LifeEvent::Open { ui: "craft".into(), id: f.bench.clone().unwrap_or_default() }),
        "pickup" => {
            if let Some(pack) = f.pack.filter(|&id| pack_index(life, id).is_some()) {
                pick_up(life, sim, pack);
            }
        }
        "board" => {
            if let Some(v) = vehicle {
                board(life, sim, v);
            }
        }
        "load" => {
            if let Some(v) = vehicle {
                load_pack(life, sim, v, slot);
            }
        }
        "unload" => {
            if let Some(v) = vehicle {
                unload_pack(life, sim, v, slot);
            }
        }
        "exit" => {
            dismount(life, sim);
        }
        "plant" => {
            let seed = chosen_seed(life);
            if let (Some(sc), Some(seed)) = (sc, seed) {
                life.state.seed = seed.clone();
                if has(&item_def(&seed).raises) {
                    raise(life, sc, cell, &seed);
                } else {
                    plant(life, sc, cell, &seed);
                }
            }
        }
        "feed" => {
            if let Some(sc) = sc.filter(|&sc| plant_at(life, sc, cell).is_some_and(|p| p.is_animal())) {
                feed(life, sc, cell);
            }
        }
        "collect" => {
            if let Some(sc) = sc {
                collect(life, sc, cell, f.x, f.y, f.z);
            }
        }
        "water" => {
            if let Some(sc) = sc.filter(|&sc| plant_at(life, sc, cell).is_some()) {
                water(life, sc, cell);
            }
        }
        "harvest" => {
            if let Some(sc) = sc {
                harvest(life, sc, cell, f.y);
            }
        }
        "fell" => {
            if let Some(sc) = sc {
                fell(life, sc, cell, f.y);
            }
        }
        "gather" => gather(life, &f),
        "claim" => {
            let bp = life.state.bag.iter().find(|s| s.item.starts_with("blueprint.")).map(|s| s.item.clone());
            if let Some(bp) = bp {
                place_house(life, sim, &f.plot.clone().unwrap_or_default(), &bp);
            }
        }
        "deliver" => {
            if let Some(h) = house {
                deliver_material(life, sim, h);
            }
        }
        "build" => {
            if let Some(h) = house {
                build_stage(life, sim, h);
            }
        }
        "rest" => {
            let Some(hi) = house.and_then(|h| house_index(life, h)) else { return };
            let (bx, bz) = interior_point(life, &life.state.houses[hi], "bed");
            life.resting = true;
            life.state.home = Some(Home { x: bx, z: bz });
            sim.player.vel.x = 0.0;
            sim.player.vel.z = 0.0;
            life.toast("You settle in. Labor recovers 3× faster while you rest - move to get up.", "info");
        }
        "storage" => life.emit(LifeEvent::Open { ui: "storage".into(), id: f.house.map(|h| h.to_string()).unwrap_or_default() }),
        "tax" => {
            if let Some(h) = house {
                pay_tax(life, h);
            }
        }
        "placeScarecrow" => {
            let Some(pl) = life.placing.clone() else { return };
            if pl.problem.as_deref().is_some_and(|p| !p.is_empty()) {
                return;
            }
            if !life.take(&pl.item, 1) {
                life.placing = None;
                return;
            }
            add_scarecrow(life, sim, pl.x, pl.z, pl.rot);
            life.placing = None;
            life.toast("🧑‍🌾 Plot claimed. Walk onto the soil and press F to plant.", "good");
            life.notify(QuestEvent::new("placeScarecrow"));
        }
        "keel" => {
            if let Some(design) = design_items_in_bag(life).into_iter().next() {
                lay_keel(life, &slip, &design);
            }
        }
        "shipDeliver" => {
            if let Some(b) = ship_on(life, &slip) {
                let id = life.state.ships[b].id;
                deliver_ship_material(life, sim, id);
            }
        }
        "shipBuild" => {
            if let Some(b) = ship_on(life, &slip) {
                let id = life.state.ships[b].id;
                build_ship_stage(life, id);
            }
        }
        "launch" => {
            if let Some(b) = ship_on(life, &slip) {
                let id = life.state.ships[b].id;
                launch(life, id);
            }
        }
        _ => {} // "info"
    }
}

/// F at a resource node: timber, stone, ore or herbs into your bag, and the node rests a while.
fn gather(life: &mut Life, f: &Focus) {
    let zone: &'static Zone = life.zone;
    let Some((i, nd)) = f.node.and_then(|n| usize::try_from(n).ok()).and_then(|i| zone.recipe.nodes.get(i).map(|nd| (i, nd))) else { return };
    let Some(y) = gathering().get(&nd.kind) else { return };
    if !node_ready(life, i) {
        return;
    }
    if !life.has_room(&y.item, y.n[1]) {
        life.toast("Your bag is full", "bad");
        return;
    }
    if !life.afford(0.0, 0.0, y.labor, &y.verb.to_lowercase()) {
        return;
    }
    let n = life.rand_int(y.n[0], y.n[1]);
    life.give(&y.item, n, false);
    if let Some(rare) = &y.rare {
        if life.rand() < rare.chance {
            life.give(&rare.item, 1, false);
            life.toast("⚡ A thunderstruck log!", "coin");
            life.emit(LifeEvent::Thunder { x: nd.x, y: f.y, z: nd.z });
        }
    }
    let back = life.state.clock + y.respawn;
    life.state.nodes.insert(i.to_string(), back);
    life.revision += 1;
    life.emit(LifeEvent::Gather { x: nd.x, y: f.y, z: nd.z, kind: y.kind.clone() });
    life.notify(QuestEvent { kind: Some(y.kind.clone()), ..QuestEvent::new("gather") });
}

/// Every step: resting ends as soon as you move.
pub fn keep_resting(life: &mut Life, sim: &mut Sim) {
    if !life.resting {
        return;
    }
    let p = &sim.player;
    if p.vel.x.hypot(p.vel.z) > 0.6 || p.mode != Mode::Normal {
        life.resting = false;
    }
}

// The expected prompts, toasts and numbers here are what the TypeScript rules give for the same
// steps on the same island. (Townsfolk, vehicles, packs, houses and the slipway need the modules
// being ported alongside this one, so they are checked once everything is together.)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::farming::tests::{got, island, stand};
    use crate::life::state::Stack;

    /// What the prompt says: (action, label, detail, ok).
    fn prompt(life: &mut Life, sim: &Sim) -> (String, String, String, bool) {
        let f = find_focus(life, sim).expect("something to do here");
        (f.action, f.label, f.detail.unwrap_or_default(), f.ok)
    }

    fn says(action: &str, label: &str, detail: &str, ok: bool) -> (String, String, String, bool) {
        (action.into(), label.into(), detail.into(), ok)
    }

    fn toasts(life: &mut Life) -> Vec<String> {
        life.drain_events()
            .into_iter()
            .map(|e| match e {
                LifeEvent::Toast { text, .. } => text,
                other => panic!("not a toast: {other:?}"),
            })
            .collect()
    }

    #[test]
    fn short_times_read_like_the_browsers() {
        let cases = [(0.0, "0s"), (0.2, "1s"), (59.2, "1m 0s"), (61.0, "1m 1s"), (3599.0, "59m 59s"), (3725.0, "1h 2m"), (86400.0, "1d 0h"), (90061.0, "1d 1h"), (-3.0, "0s"), (f64::NAN, "NaNs")];
        for (s, want) in cases {
            assert_eq!(short_time(s), want, "{s}");
        }
        assert_eq!((num(-0.0), num(250.0), num(0.25), num(1e21)), ("0".into(), "250".into(), "0.25".into(), "1e+21".into()));
    }

    #[test]
    fn the_prompt_is_whatever_is_in_the_cell_in_front_of_you() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        let sc = add_scarecrow(&mut life, &mut sim, -208.0, -240.0, 0.0);
        let aim = |life: &Life, sim: &mut Sim, idx: usize| {
            let (x, z) = cell_centre(&life.state.scarecrows[0], idx);
            stand(sim, x, z - 1.3, 0.0);
        };
        aim(&life, &mut sim, 0);
        let f = find_focus(&mut life, &sim).unwrap();
        assert_eq!((f.key.as_str(), f.sc, f.cell), ("cell:1:0", Some(sc), Some(0)));
        assert_eq!(prompt(&mut life, &sim), says("info", "Empty soil", "Buy seeds from Mara, or young animals from Sela", false));
        life.give("seed.sunroot", 5, true);
        assert_eq!(prompt(&mut life, &sim), says("plant", "Plant Sunroot", "5 left · Z: change seed", true));
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!(prompt(&mut life, &sim), says("water", "Water Sunroot", "0% · ripe in ~2m 30s", true));
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!(prompt(&mut life, &sim), says("info", "Sunroot - 0%", "watered · ripe in ~2m 0s", false));
        life.state.clock += 150.0;
        grow_for(&mut life, 150.0);
        assert_eq!(prompt(&mut life, &sim), says("harvest", "Harvest Sunroot", "2 labor", true));

        life.give("animal.chick", 1, true);
        run_command(&mut life, &mut sim, &Command::Use { item: "animal.chick".into() });
        aim(&life, &mut sim, 1);
        assert_eq!(prompt(&mut life, &sim), says("plant", "Raise Chick", "1 left · Z: change seed", true));
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!(prompt(&mut life, &sim), says("feed", "Feed the chick", "growing 0% · fed for 5m 0s", false));
        life.state.clock += 301.0;
        grow_for(&mut life, 301.0);
        assert_eq!(prompt(&mut life, &sim), says("feed", "Feed the chicken", "2 Barley · hungry", false));
        life.give("barley", 4, true);
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!(prompt(&mut life, &sim), says("feed", "Feed the chicken", "egg 0% · fed for 5m 0s", true));
        life.state.clock += 300.0;
        grow_for(&mut life, 300.0);
        assert_eq!(prompt(&mut life, &sim), says("collect", "Collect eggs", "1 labor", true));
        // From inside the plot, facing back toward its post.
        stand(&mut sim, -207.0, -239.0, 2.4);
        assert_eq!(prompt(&mut life, &sim), says("plant", "Plant Sunroot", "4 left · Z: change seed", true));
        assert_eq!(find_focus(&mut life, &sim).unwrap().key, "cell:1:10");
        assert_eq!(toasts(&mut life), ["F plants Chick now"]);
        // What was pressed last is kept as the focus.
        assert_eq!(life.focus.as_ref().map(|f| f.action.as_str()), Some("feed"));
    }

    #[test]
    fn pressing_f_at_a_node_gathers_from_it_and_it_rests_a_while() {
        let (mut life, mut world, mut p) = island();
        let nd = life.zone.recipe.nodes[0].clone();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        stand(&mut sim, nd.x, nd.z - 2.4, 0.0);
        let f = find_focus(&mut life, &sim).unwrap();
        assert_eq!((f.action.as_str(), f.label.as_str(), f.detail.as_deref(), f.key.as_str(), f.node), ("gather", "Chop timber", Some("8 labor"), "node:0", Some(0)));
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!(life.state.bag, vec![Stack { item: "lumber".into(), n: 5 }]);
        assert_eq!(life.state.labor, 792.0);
        assert_eq!(life.drain_events(), vec![got(5, "lumber"), LifeEvent::Gather { x: nd.x, y: f.y, z: nd.z, kind: "timber".into() }]);
        assert_eq!(life.state.nodes.get("0"), Some(&60.0));
        assert_eq!(prompt(&mut life, &sim), says("info", "Deadfall Timber - picked clean", "back in 1m 0s", false));
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!(life.state.bag, vec![Stack { item: "lumber".into(), n: 5 }], "picked clean");
        life.state.clock = 60.0;
        assert!(node_ready(&life, 0) && node_ready(&life, 1));
        // Too tired to chop.
        life.state.labor = 3.0;
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!(toasts(&mut life), ["Too tired - not enough labor to chop timber"]);
    }

    #[test]
    fn a_scarecrow_is_walked_out_and_put_down_in_front_of_you() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        life.give("scarecrow", 2, true);
        stand(&mut sim, -208.0, -247.0, 0.1);
        run_command(&mut life, &mut sim, &Command::Use { item: "scarecrow".into() });
        assert_eq!(life.placing, Some(Placement { item: "scarecrow".into(), ..Default::default() }));
        assert_eq!(prompt(&mut life, &sim), says("placeScarecrow", "Place scarecrow here", "Esc to cancel", true));
        // Seven metres ahead, turned to the nearest 15 degrees.
        let pl = life.placing.clone().unwrap();
        assert!((pl.x + 207.3011660834722).abs() < 1e-9 && (pl.z + 240.03497084305383).abs() < 1e-9, "{pl:?}");
        assert_eq!((pl.rot, pl.problem), (0.0, None));
        run_command(&mut life, &mut sim, &Command::Interact);
        let sc = &life.state.scarecrows;
        assert!(sc.len() == 1 && (sc[0].x, sc[0].z, sc[0].rot) == (pl.x, pl.z, 0.0));
        assert!(life.placing.is_none() && life.count("scarecrow") == 1);
        assert_eq!(toasts(&mut life), ["Walk to open, level ground and press F to place. Esc cancels.", "🧑\u{200d}🌾 Plot claimed. Walk onto the soil and press F to plant."]);
        // Its tilled ground is no place for the next one.
        run_command(&mut life, &mut sim, &Command::Use { item: "scarecrow".into() });
        assert_eq!(prompt(&mut life, &sim).1, "Too close to a road or building");
        run_command(&mut life, &mut sim, &Command::Interact);
        assert_eq!((life.state.scarecrows.len(), life.count("scarecrow")), (1, 1));
        // Turning snaps the scarecrow round in 15 degree steps; Esc puts it away.
        stand(&mut sim, -150.0, -214.0, 0.5);
        find_focus(&mut life, &sim);
        assert_eq!(life.placing.as_ref().unwrap().rot, 2.0 * (PI / 12.0));
        run_command(&mut life, &mut sim, &Command::CancelPlace);
        assert!(life.placing.is_none());
    }

    #[test]
    fn commands_from_the_bag_and_the_developer_panel() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        stand(&mut sim, -150.0, -214.0, 1.0);
        for (item, n) in [("seed.flax", 2), ("seed.sunroot", 1), ("animal.calf", 1), ("glider.wayfarer", 1), ("tonic.labor", 2), ("blueprint.cottage", 1), ("design.cog", 1), ("scarecrow", 1)] {
            life.give(item, n, true);
        }
        let used = |item: &str| Command::Use { item: item.into() };
        let commands = [
            Command::CycleSeed,
            Command::CycleSeed,
            Command::CycleSeed,
            Command::CycleSeed,
            used("glider.wayfarer"),
            used("tonic.labor"),
            used("blueprint.cottage"),
            used("design.cog"),
            used("sunroot"),
            Command::Grant { item: None, n: None, coins: None, seals: None, labor: Some(5000.0) },
            Command::Grant { item: None, n: None, coins: Some(150.0), seals: Some(2.0), labor: None },
            Command::Grant { item: Some("stone".into()), n: Some(4), coins: None, seals: None, labor: None },
            Command::Craft { recipe: "pack.harvestCrate".into() },
            Command::Craft { recipe: "craft.tonic".into() },
            Command::Craft { recipe: "no.such.recipe".into() },
        ];
        for c in &commands {
            run_command(&mut life, &mut sim, c);
        }
        let stone = item_def("stone");
        assert_eq!(
            toasts(&mut life),
            [
                "Planting Sunroot Seeds",
                "Planting Calf",
                "Planting Flax Seeds",
                "Planting Sunroot Seeds",
                "Wayfarer Glider equipped",
                "+250 labor",
                "Take it to an empty plot at Hearthside Rise and press F there",
                "Take it to the Lanternwick slipway beside the shipwright and press F there",
                &format!("+4 {} {}", stone.icon, stone.name),
                "Too far from the workbench",
                "Too far from the workbench",
            ]
        );
        let s = &life.state;
        assert_eq!((s.seed.as_str(), s.glider.as_str(), sim.player.glider.as_str()), ("seed.sunroot", "wayfarer", "wayfarer"));
        assert_eq!((s.labor, s.coins, s.seals, life.count("tonic.labor"), life.count("stone")), (1000.0, 350.0, 2.0, 1, 4));
    }

    #[test]
    fn resting_ends_as_soon_as_you_move() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        run_command(&mut life, &mut sim, &Command::Rest);
        keep_resting(&mut life, &mut sim);
        assert!(life.resting);
        (sim.player.vel.x, sim.player.vel.z) = (0.5, 0.3);
        keep_resting(&mut life, &mut sim);
        assert!(life.resting, "a shuffle is not getting up");
        sim.player.vel.z = 0.4;
        keep_resting(&mut life, &mut sim);
        assert!(!life.resting);
        run_command(&mut life, &mut sim, &Command::Rest);
        (sim.player.vel.x, sim.player.vel.z, sim.player.mode) = (0.0, 0.0, Mode::Swim);
        keep_resting(&mut life, &mut sim);
        assert!(!life.resting);
    }

    #[test]
    fn presses_and_commands_about_things_that_are_not_there_change_nothing() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        stand(&mut sim, -150.0, -214.0, 1.0);
        life.give("sunroot", 3, true);
        let before = serde_json::to_value(&life.state).unwrap();
        let commands = [
            Command::Store { house: 1, item: "sunroot".into(), n: 3 },
            Command::Take { house: 1, item: "sunroot".into(), n: 3 },
            Command::PayTax { house: 1 },
            Command::Contract { id: 5 },
            Command::Buy { npc: "mara".into(), item: "seed.sunroot".into(), n: 2 },
            Command::Sell { npc: "mara".into(), item: "sunroot".into(), n: 2 },
            Command::Buy { npc: "nobody".into(), item: "seed.sunroot".into(), n: 2 },
            Command::Use { item: "tonic.labor".into() },
            Command::Use { item: "no-such-thing".into() },
            Command::Use { item: "sunroot".into() },
            Command::CycleSeed,
            Command::CancelPlace,
        ];
        for c in &commands {
            run_command(&mut life, &mut sim, c);
        }
        // Gliding or swinging a sword, F has nothing to do; in a saddle it gets you down.
        sim.player.mode = Mode::Glide;
        run_command(&mut life, &mut sim, &Command::Interact);
        assert!(find_focus(&mut life, &sim).is_none() && life.focus.is_none());
        sim.player.mode = Mode::Attack;
        assert!(find_focus(&mut life, &sim).is_none());
        sim.player.mode = Mode::Ride;
        assert_eq!(prompt(&mut life, &sim), says("exit", "Get out", "", true));
        assert_eq!(serde_json::to_value(&life.state).unwrap(), before);
        assert!(life.drain_events().is_empty());
    }
}
