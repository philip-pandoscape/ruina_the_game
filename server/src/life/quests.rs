//! The starter questline (src/sim/life/quests.ts): offered by NPCs once its prerequisites are
//! done, advanced by events the other systems report (planted, harvested, delivered...), handed
//! in for rewards.

use super::content::{js_hypot, format_coins, has_quest, item_def, js_max, js_min, labor, objective_target, quest_def, quests, ship_designs, ItemCount, Objective, QuestDef, QuestStep};
use super::state::{Plant, QuestProgress};
use super::{step_seconds, Life, LifeEvent, QuestEvent};
use crate::open::Sim;
use crate::player::Mode;

pub fn quest_done(life: &Life, id: &str) -> bool {
    life.state.quests.done.iter().any(|d| d == id)
}

/// Index of the quest in life.state.quests.active, if it is active.
pub fn quest_active(life: &Life, id: &str) -> Option<usize> {
    life.state.quests.active.iter().position(|q| q.id == id)
}

/// The step a quest is on (None once every step is done).
fn step_of(q: &'static QuestDef, step: i64) -> Option<&'static QuestStep> {
    usize::try_from(step).ok().and_then(|s| q.steps.get(s))
}

/// An optional name as JavaScript tests it: missing and "" both count as not given.
fn given(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// An optional number as JavaScript tests it: missing, 0 and NaN all count as not given.
fn truthy(x: Option<f64>) -> Option<f64> {
    x.filter(|x| *x != 0.0 && !x.is_nan())
}

/// Offered and not yet taken.
pub fn available(life: &Life, q: &QuestDef) -> bool {
    !quest_done(life, &q.id) && quest_active(life, &q.id).is_none() && q.after.iter().all(|a| quest_done(life, a))
}

pub fn is_ready(life: &Life, id: &str) -> bool {
    quest_active(life, id).is_some_and(|i| life.state.quests.active[i].step >= quest_def(id).steps.len() as i64)
}

/// Quests this NPC has to give, and quests ready to hand in to them: (offer, turn_in).
pub fn quests_at(life: &Life, npc: &str) -> (Vec<&'static QuestDef>, Vec<&'static QuestDef>) {
    let offer = quests().iter().filter(|q| q.giver == npc && available(life, q) && q.auto != Some(true)).collect();
    let turn_in = quests().iter().filter(|q| q.turn_in.as_deref().unwrap_or(&q.giver) == npc && is_ready(life, &q.id)).collect();
    (offer, turn_in)
}

pub fn start_quests(life: &mut Life) {
    // Catching up advances quests but never adds or removes one, so the list keeps its shape.
    for i in 0..life.state.quests.active.len() {
        catch_up(life, i);
    }
    for q in quests() {
        if q.auto == Some(true) && available(life, q) {
            accept(life, &q.id);
        }
    }
}

/// Room in the bag for all of these at once (one kind at a time is close enough for a few items).
fn room_for(life: &Life, items: Option<&Vec<ItemCount>>) -> bool {
    items.is_none_or(|items| items.iter().all(|i| life.has_room(&i.item, i.n)))
}

/// How much of an objective the world already shows done: a plot you already claimed, a house you
/// already raised, a ship already launched. Those count the moment the step starts, so doing
/// things in your own order never locks a quest.
fn already_done(life: &Life, o: &Objective) -> f64 {
    let s = &life.state;
    let launched = ship_designs().iter().any(|d| life.count(&d.deed) > 0);
    let plants = || s.scarecrows.iter().flat_map(|sc| sc.cells.iter().flatten());
    let crop = |c: &Plant| given(&o.crop).is_none_or(|crop| c.crop == crop);
    let n = match o.type_.as_str() {
        "placeScarecrow" => s.scarecrows.len(),
        "plant" => plants().filter(|c| !c.is_animal() && crop(c)).count(),
        "raise" => plants().filter(|c| c.is_animal() && crop(c)).count(),
        "craftPack" => s.packs.iter().filter(|pk| given(&o.pack).is_none_or(|pack| pk.def == pack)).count(),
        "load" => s.packs.iter().filter(|pk| pk.at == "cargo").count(),
        "summon" => usize::from(s.vehicles.iter().any(|v| o.vehicle.as_deref() == Some(v.def.as_str()))),
        "placeHouse" => s.houses.len(),
        "buildStage" => return s.houses.iter().fold(0.0, |m, h| js_max(m, h.stage as f64)),
        "layKeel" => usize::from(!s.ships.is_empty() || launched),
        "shipStage" => return if launched { objective_target(o) } else { s.ships.iter().fold(0.0, |m, b| js_max(m, b.stage as f64)) },
        "launch" => usize::from(launched),
        _ => 0,
    };
    n as f64
}

/// Credits whatever the world already shows done for this step, and moves on if that is all of it.
fn catch_up(life: &mut Life, i: usize) {
    let p = &life.state.quests.active[i];
    let id = p.id.clone();
    let Some(step) = step_of(quest_def(&id), p.step) else { return };
    let counts: Vec<f64> = step
        .objectives
        .iter()
        .enumerate()
        .map(|(k, o)| js_max(p.counts.get(k).copied().unwrap_or(0.0), js_min(objective_target(o), already_done(life, o))))
        .collect();
    let all = step.objectives.iter().zip(&counts).all(|(o, n)| *n >= objective_target(o));
    life.state.quests.active[i].counts = counts;
    if all {
        advance(life, &id);
    }
}

fn start_step(life: &mut Life, i: usize) {
    life.state.quests.active[i].counts.clear();
    catch_up(life, i);
}

pub fn accept(life: &mut Life, id: &str) -> bool {
    // The TypeScript throws on a quest that doesn't exist; here it just isn't taken.
    if !has_quest(id) {
        return false;
    }
    let q = quest_def(id);
    if !available(life, q) {
        return false;
    }
    if !room_for(life, q.start_items.as_ref()) {
        life.toast("Make some room in your bag first", "bad");
        return false;
    }
    life.state.quests.active.push(QuestProgress { id: id.to_string(), step: 0, counts: Vec::new() });
    let i = life.state.quests.active.len() - 1;
    for s in q.start_items.iter().flatten() {
        life.give(&s.item, s.n, false);
    }
    life.emit(LifeEvent::Quest { id: id.to_string(), what: "accepted".into() });
    life.toast(format!("New quest: {}", q.name), "quest");
    start_step(life, i);
    true
}

pub fn complete(life: &mut Life, id: &str) -> bool {
    if !is_ready(life, id) {
        return false;
    }
    let q = quest_def(id);
    let r = &q.rewards;
    if !room_for(life, r.items.as_ref()) {
        life.toast("Make some room in your bag for the reward first", "bad");
        return false;
    }
    let s = &mut life.state;
    s.quests.active.retain(|p| p.id != id);
    s.quests.done.push(id.to_string());
    if let Some(coins) = truthy(r.coins) {
        s.coins += coins;
    }
    if let Some(seals) = truthy(r.seals) {
        s.seals += seals;
    }
    if let Some(l) = truthy(r.labor) {
        s.labor = js_min(labor().max, s.labor + l);
    }
    for it in r.items.iter().flatten() {
        life.give(&it.item, it.n, false);
    }
    if let Some(g) = given(&r.equip_glider) {
        life.state.glider = g.to_string();
    }
    let mut bits = vec![
        truthy(r.coins).map(format_coins).unwrap_or_default(),
        truthy(r.seals).map(|n| format!("{n} seal{}", if n > 1.0 { "s" } else { "" })).unwrap_or_default(),
    ];
    bits.extend(r.items.iter().flatten().map(|i| format!("{}{}", if i.n > 1 { format!("{} ", i.n) } else { String::new() }, item_def(&i.item).name)));
    bits.retain(|b| !b.is_empty());
    let list = if bits.is_empty() { String::new() } else { format!(" - {}", bits.join(", ")) };
    life.toast(format!("✔ {} complete{list}", q.name), "quest");
    life.emit(LifeEvent::Quest { id: id.to_string(), what: "done".into() });
    // Anything that just became available and starts by itself.
    start_quests(life);
    true
}

fn matches(o: &Objective, e: &QuestEvent) -> bool {
    // Each detail the objective names has to be the event's.
    let named = |want: &Option<String>, got: &Option<String>| given(want).is_none_or(|w| got.as_deref() == Some(w));
    o.type_ == e.type_
        && named(&o.place, &e.place)
        && named(&o.npc, &e.npc)
        && named(&o.crop, &e.crop)
        && named(&o.pack, &e.pack)
        && named(&o.outpost, &e.outpost)
        && named(&o.vehicle, &e.vehicle)
}

pub fn notify_quests(life: &mut Life, e: &QuestEvent) {
    // By index over the live list: advancing a quest never adds or removes one.
    let mut i = 0;
    while i < life.state.quests.active.len() {
        let p = &mut life.state.quests.active[i];
        i += 1;
        let Some(step) = step_of(quest_def(&p.id), p.step) else { continue };
        let mut changed = false;
        for (k, o) in step.objectives.iter().enumerate() {
            let target = objective_target(o);
            // Counts always cover the step's objectives (catch_up fills them in); a short list from
            // a damaged save counts from zero.
            let have = p.counts.get(k).copied().unwrap_or(0.0);
            if have >= target || !matches(o, e) {
                continue;
            }
            if p.counts.len() <= k {
                p.counts.resize(k + 1, 0.0);
            }
            p.counts[k] = js_min(target, have + e.amount.unwrap_or(1.0));
            changed = true;
        }
        if !changed {
            continue;
        }
        if step.objectives.iter().enumerate().all(|(k, o)| p.counts.get(k).is_some_and(|n| *n >= objective_target(o))) {
            let id = p.id.clone();
            advance(life, &id);
        }
    }
}

fn advance(life: &mut Life, id: &str) {
    let Some(i) = quest_active(life, id) else { return };
    let q = quest_def(id);
    let p = &mut life.state.quests.active[i];
    p.step += 1;
    let step = p.step;
    if step >= q.steps.len() as i64 {
        p.counts.clear();
        life.emit(LifeEvent::Quest { id: id.to_string(), what: "ready".into() });
        life.toast(format!("{}: return to {}", q.name, q.turn_in.as_deref().unwrap_or(&q.giver)), "quest");
        return;
    }
    life.emit(LifeEvent::Quest { id: id.to_string(), what: "step".into() });
    life.toast(format!("{}: {}", q.name, step_of(q, step).map_or("", |s| s.text.as_str())), "quest");
    start_step(life, i);
}

/// Objectives measured rather than reported: getting somewhere, time in the air.
pub fn step_quests(life: &mut Life, sim: &mut Sim) {
    let p = &*sim.player;
    let (x, y, z) = (p.pos.x, p.pos.y, p.pos.z);
    if p.mode == Mode::Glide {
        notify_quests(life, &QuestEvent { amount: Some(step_seconds()), ..QuestEvent::new("glide") });
    }
    if life.state.clock % 0.25 < step_seconds() {
        let zone = life.zone;
        let mut i = 0;
        while i < life.state.quests.active.len() {
            let qp = &life.state.quests.active[i];
            i += 1;
            let Some(step) = step_of(quest_def(&qp.id), qp.step) else { continue };
            for o in &step.objectives {
                if o.type_ != "reach" {
                    continue;
                }
                let Some(place) = given(&o.place) else { continue };
                let Some(pl) = zone.recipe.places.iter().find(|pl| pl.id == place) else { continue };
                if js_hypot(x - pl.x, z - pl.z) <= o.r.unwrap_or(20.0) && y >= o.min_y.unwrap_or(f64::NEG_INFINITY) {
                    notify_quests(life, &QuestEvent { place: Some(place.to_string()), ..QuestEvent::new("reach") });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::state::{Scarecrow, ShipBuild};
    use crate::life::trade::testing::{island, toasts};

    fn talk(life: &mut Life, npc: &str) {
        life.notify(QuestEvent { npc: Some(npc.to_string()), ..QuestEvent::new("talk") });
    }

    fn ids(list: &[&QuestDef]) -> Vec<String> {
        list.iter().map(|q| q.id.clone()).collect()
    }

    fn step(life: &Life, id: &str) -> i64 {
        life.state.quests.active[quest_active(life, id).expect("active")].step
    }

    /// Every slot taken by something else.
    fn fill_bag(life: &mut Life) {
        life.state.bag.clear();
        for i in 0..crate::life::content::bag_slots() {
            life.state.bag.push(crate::life::state::Stack { item: format!("filler{i}"), n: 1 });
        }
    }

    #[test]
    fn the_first_quest_starts_by_itself_and_talking_to_hollis_finishes_it() {
        let (mut life, _, _) = island(0.0);
        let events = life.drain_events();
        assert_eq!(
            events,
            [LifeEvent::Quest { id: "landfall".into(), what: "accepted".into() }, LifeEvent::Toast { text: "New quest: Landfall".into(), kind: "quest".into() }]
        );
        assert!(!is_ready(&life, "landfall"));
        let (offer, turn_in) = quests_at(&life, "hollis");
        assert!(offer.is_empty() && turn_in.is_empty(), "landfall starts by itself, it isn't offered");
        // Talking to anyone else doesn't count.
        talk(&mut life, "mara");
        life.notify(QuestEvent::new("plant"));
        assert!(!is_ready(&life, "landfall"));
        talk(&mut life, "hollis");
        assert!(is_ready(&life, "landfall"));
        assert_eq!(toasts(&mut life), ["Landfall: return to hollis"]);
        assert_eq!(ids(&quests_at(&life, "hollis").1), ["landfall"]);
        // Handing it in pays out, and opens the next quests.
        assert!(complete(&mut life, "landfall"));
        assert!(quest_done(&life, "landfall") && quest_active(&life, "landfall").is_none());
        assert_eq!(life.state.coins, 50.0);
        assert_eq!((life.count("scarecrow"), life.count("seed.sunroot"), life.count("seed.barley")), (1, 8, 6));
        assert_eq!(life.state.seed, "seed.sunroot");
        let events = life.drain_events();
        assert!(events.contains(&LifeEvent::Toast { text: "✔ Landfall complete - 50c, Scarecrow, 8 Sunroot Seeds, 6 Barley Seeds".into(), kind: "quest".into() }));
        assert_eq!(events.last(), Some(&LifeEvent::Quest { id: "landfall".into(), what: "done".into() }));
        assert_eq!(ids(&quests_at(&life, "hollis").0), ["patch", "wings"]);
        // Once only.
        assert!(!complete(&mut life, "landfall"));
        assert!(!accept(&mut life, "landfall"));
    }

    #[test]
    fn quests_wait_for_what_comes_before_and_for_room_in_the_bag() {
        let (mut life, _, _) = island(0.0);
        assert!(!accept(&mut life, "patch"), "landfall first");
        assert!(!accept(&mut life, "no-such-quest"));
        assert!(!complete(&mut life, "no-such-quest"));
        assert!(!complete(&mut life, "landfall"), "not ready");
        talk(&mut life, "hollis");
        // Each kind of reward has to fit (one kind at a time, like the TypeScript).
        fill_bag(&mut life);
        toasts(&mut life);
        assert!(!complete(&mut life, "landfall"));
        assert_eq!(toasts(&mut life), ["Make some room in your bag for the reward first"]);
        assert!(is_ready(&life, "landfall") && life.state.coins == 0.0);
        life.state.bag.pop();
        assert!(complete(&mut life, "landfall"));
        let scarecrow = format!("+1 {} Scarecrow", item_def("scarecrow").icon);
        assert_eq!(toasts(&mut life)[..2], [scarecrow.as_str(), "Your bag is full - 8 Sunroot Seeds left behind"]);
        // A quest that hands you something needs room for it.
        life.state.quests.done.push("patch".into());
        fill_bag(&mut life);
        toasts(&mut life);
        assert!(!accept(&mut life, "livestock"));
        assert_eq!(toasts(&mut life), ["Make some room in your bag first"]);
        life.state.bag.clear();
        assert!(accept(&mut life, "livestock"));
        assert_eq!(life.count("animal.chick"), 1);
    }

    #[test]
    fn a_quest_counts_what_the_island_already_shows_done() {
        let (mut life, _, _) = island(0.0);
        talk(&mut life, "hollis");
        assert!(complete(&mut life, "landfall"));
        // A scarecrow already up with eight things growing: both steps of the patch quest are done.
        let mut cells = vec![None; 16];
        for c in cells.iter_mut().take(8) {
            *c = Some(Plant { crop: "sunroot".into(), growth: 0.2, ..Default::default() });
        }
        life.state.scarecrows.push(Scarecrow { id: 90, x: 0.0, z: 0.0, rot: 0.0, cells });
        toasts(&mut life);
        assert!(accept(&mut life, "patch"));
        assert!(is_ready(&life, "patch"));
        assert_eq!(toasts(&mut life), ["New quest: A Patch of Earth", "A Patch of Earth: Plant seeds in your plot", "A Patch of Earth: return to hollis"]);
        // Its reward includes labor, never past the most you can hold.
        life.state.labor = 950.0;
        assert!(complete(&mut life, "patch"));
        assert_eq!((life.state.coins, life.state.labor, life.count("seed.flax")), (90.0, 1000.0, 6));
        // A ship already launched counts for every step of the shipwright's quest.
        life.state.quests.done.extend(["westward".to_string(), "saltSail".to_string()]);
        life.give("deed.cog", 1, true);
        assert!(accept(&mut life, "shipwright"));
        assert!(is_ready(&life, "shipwright"));
        // A house part built counts its stages.
        life.state.quests.done.push("firstFlight".into());
        life.state.houses.push(crate::life::state::House { id: 5, plot: "rise-1".into(), blueprint: "cottage".into(), stage: 2, ..Default::default() });
        assert!(accept(&mut life, "home"));
        let p = &life.state.quests.active[quest_active(&life, "home").unwrap()];
        assert_eq!((p.step, p.counts.as_slice()), (1, [2.0].as_slice()));
        life.notify(QuestEvent::new("buildStage"));
        life.notify(QuestEvent::new("buildStage"));
        assert!(is_ready(&life, "home"));
        // Half a ship on the slip is counted too.
        let (mut life, _, _) = island(0.0);
        life.state.quests.done.extend(["landfall".to_string(), "westward".to_string(), "saltSail".to_string()]);
        life.state.quests.active.clear();
        life.state.ships.push(ShipBuild { id: 3, slip: "lanternwick-slip".into(), design: "cog".into(), stage: 3, ..Default::default() });
        assert!(accept(&mut life, "shipwright"));
        let p = &life.state.quests.active[quest_active(&life, "shipwright").unwrap()];
        assert_eq!((p.step, p.counts.as_slice()), (1, [3.0].as_slice()));
    }

    #[test]
    fn objectives_match_only_what_they_name() {
        let (mut life, _, _) = island(0.0);
        life.state.quests.active.clear();
        life.state.quests.done.extend(["landfall", "patch", "harvest", "packwright"].map(String::from));
        assert!(accept(&mut life, "westward"));
        let deliver = |outpost: &str| QuestEvent { outpost: Some(outpost.into()), pack: Some("flaxBale".into()), ..QuestEvent::new("deliver") };
        life.notify(deliver("gullrock"));
        life.notify(QuestEvent::new("deliver"));
        assert!(!is_ready(&life, "westward"));
        life.notify(deliver("westwatch"));
        assert!(is_ready(&life, "westward"));
        assert_eq!(ids(&quests_at(&life, "dunmore").1), ["westward"], "handed in to Dunmore, not Tamsin");
        assert!(quests_at(&life, "tamsin").1.is_empty());
        // The rewards: coin and a cart deed, which opens three more quests.
        assert!(complete(&mut life, "westward"));
        assert_eq!((life.state.coins, life.count("deed.farmCart")), (60.0, 1));
        assert_eq!(ids(&quests_at(&life, "bertram").0), ["wheels"]);
        assert_eq!(ids(&quests_at(&life, "ilsa").0), ["saltSail"]);
        assert_eq!(ids(&quests_at(&life, "dunmore").0), ["contracts"]);
        // Summoning: only the vehicle it names.
        assert!(accept(&mut life, "wheels"));
        life.notify(QuestEvent { vehicle: Some("rowboat".into()), ..QuestEvent::new("summon") });
        assert_eq!(step(&life, "wheels"), 0);
        life.notify(QuestEvent { vehicle: Some("farmCart".into()), ..QuestEvent::new("summon") });
        assert_eq!(step(&life, "wheels"), 1);
        // Counting up to the target and no further.
        for _ in 0..3 {
            life.notify(QuestEvent::new("load"));
        }
        assert_eq!(step(&life, "wheels"), 2);
        life.notify(deliver("westwatch"));
        let p = &life.state.quests.active[quest_active(&life, "wheels").unwrap()];
        assert_eq!(p.counts, [1.0]);
    }

    #[test]
    fn reaching_a_place_and_time_in_the_air_are_measured_each_step() {
        let (mut life, mut world, mut p) = island(0.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        talk(&mut life, "hollis");
        assert!(complete(&mut life, "landfall"));
        assert!(accept(&mut life, "wings"));
        let top = life.zone.recipe.places.iter().find(|pl| pl.id == "windspire").unwrap().clone();
        // Near enough, but not up on top.
        sim.player.pos.x = top.x + 20.0;
        sim.player.pos.z = top.z;
        sim.player.pos.y = 100.0;
        life.state.clock = 0.25;
        step_quests(&mut life, &mut sim);
        assert_eq!(step(&life, "wings"), 0);
        // Up there, but it is only looked at four times a second.
        sim.player.pos.y = 120.0;
        life.state.clock = 0.4;
        step_quests(&mut life, &mut sim);
        assert_eq!(step(&life, "wings"), 0);
        // Too far out.
        life.state.clock = 0.5;
        sim.player.pos.x = top.x + 31.0;
        step_quests(&mut life, &mut sim);
        assert_eq!(step(&life, "wings"), 0);
        life.state.clock = 0.75;
        sim.player.pos.x = top.x + 30.0;
        step_quests(&mut life, &mut sim);
        assert_eq!(step(&life, "wings"), 1);
        talk(&mut life, "ysolde");
        assert_eq!(ids(&quests_at(&life, "ysolde").1), ["wings"]);
        assert!(complete(&mut life, "wings"));
        assert_eq!((life.state.glider.as_str(), life.count("glider.wayfarer")), ("wayfarer", 1));
        // First Flight: twenty seconds with the glider open, a step's worth each step.
        assert!(accept(&mut life, "firstFlight"));
        step_quests(&mut life, &mut sim);
        assert_eq!(life.state.quests.active[quest_active(&life, "firstFlight").unwrap()].counts, [0.0]);
        sim.player.mode = Mode::Glide;
        let mut frames = 0;
        while step(&life, "firstFlight") == 0 && frames < 2000 {
            step_quests(&mut life, &mut sim);
            frames += 1;
        }
        assert!((1200..=1201).contains(&frames), "{frames}");
        talk(&mut life, "hollis");
        assert!(complete(&mut life, "firstFlight"));
        assert_eq!((life.state.coins, life.state.seals), (110.0, 1.0));
        let said = toasts(&mut life);
        assert_eq!(said.last().unwrap(), "✔ First Flight complete - 60c, 1 seal");
    }

    #[test]
    fn hypot_is_the_browsers() {
        assert_eq!(js_hypot(3.0, 4.0), 5.0);
        assert_eq!(js_hypot(-3.0, 0.0), 3.0);
        assert_eq!(js_hypot(0.0, 0.0), 0.0);
        assert_eq!(js_hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
        assert!(js_hypot(f64::NAN, 1.0).is_nan());
        // Math.hypot(0.1, 0.2) in V8.
        assert_eq!(js_hypot(0.1, 0.2), 0.223606797749979);
    }
}
