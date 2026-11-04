//! The starter questline (src/sim/life/quests.ts): offered by NPCs once its prerequisites are
//! done, advanced by events the other systems report (planted, harvested, delivered...), handed
//! in for rewards. Milestones live alongside: they start by themselves and are done the moment
//! their steps are.
//!
//! Finishing a milestone takes it off the active list, and can start others, in the middle of
//! whatever walk of the list got it there. The TypeScript walks the list as it was when the walk
//! began (an iterator over the old array, or a copy of it), so these walks do the same: each quest
//! that was active then, once, if it still is when its turn comes (active_ids).

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

/// The quests active right now, to walk while the list changes under the walk. One finished along
/// the way isn't found when its turn comes (the TypeScript finds its step past the end and passes
/// over it); one started along the way waits for the next walk.
fn active_ids(life: &Life) -> Vec<String> {
    life.state.quests.active.iter().map(|q| q.id.clone()).collect()
}

fn is_milestone(q: &QuestDef) -> bool {
    q.milestone == Some(true)
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
    let turn_in = quests().iter().filter(|q| !is_milestone(q) && q.turn_in.as_deref().unwrap_or(&q.giver) == npc && is_ready(life, &q.id)).collect();
    (offer, turn_in)
}

pub fn start_quests(life: &mut Life) {
    // Catching up can finish a milestone, which leaves the list and can start others.
    for id in active_ids(life) {
        if let Some(i) = quest_active(life, &id) {
            catch_up(life, i);
        }
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
    // Milestones are always there to work toward; they only speak up when they're done.
    if !is_milestone(q) {
        life.toast(format!("New quest: {}", q.name), "quest");
    }
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
    // Skill points aren't kept: they're counted from the quests you've done (progress.rs).
    let mut bits = vec![
        r.skill_points.filter(|&n| n != 0).map(|n| format!("{n} skill point{}", if n > 1 { "s" } else { "" })).unwrap_or_default(),
        truthy(r.coins).map(format_coins).unwrap_or_default(),
        truthy(r.seals).map(|n| format!("{n} seal{}", if n > 1.0 { "s" } else { "" })).unwrap_or_default(),
    ];
    bits.extend(r.items.iter().flatten().map(|i| format!("{}{}", if i.n > 1 { format!("{} ", i.n) } else { String::new() }, item_def(&i.item).name)));
    bits.retain(|b| !b.is_empty());
    let list = if bits.is_empty() { String::new() } else { format!(" - {}", bits.join(", ")) };
    let title = if is_milestone(q) { format!("Milestone: {}", q.name) } else { format!("{} complete", q.name) };
    life.toast(format!("✔ {title}{list}"), "quest");
    life.emit(LifeEvent::Quest { id: id.to_string(), what: "done".into() });
    // Anything that just became available and starts by itself.
    start_quests(life);
    true
}

/// Gives up a quest you took: it leaves your list with its progress, and its giver offers it again.
/// Milestones and the quests that start by themselves can't be given up. One that handed you
/// something to start with takes it back, so taking it again can't hand out another; once you've
/// used that, it can't be given up.
pub fn abandon(life: &mut Life, id: &str) -> bool {
    if !has_quest(id) {
        return false;
    }
    let q = quest_def(id);
    if is_milestone(q) || q.auto == Some(true) || quest_active(life, id).is_none() {
        return false;
    }
    let start = q.start_items.as_deref().unwrap_or(&[]);
    if let Some(used) = start.iter().find(|s| life.count(&s.item) < s.n) {
        life.toast(format!("You've used the {} it gave you, so it can't be given up", item_def(&used.item).name), "bad");
        return false;
    }
    for s in start {
        life.take(&s.item, s.n);
    }
    life.state.quests.active.retain(|p| p.id != id);
    life.emit(LifeEvent::Quest { id: id.to_string(), what: "abandoned".into() });
    life.toast(format!("Quest abandoned: {}", q.name), "info");
    true
}

fn matches(o: &Objective, e: &QuestEvent) -> bool {
    // Each detail the objective names has to be the event's.
    let named = |want: &Option<String>, got: &Option<String>| given(want).is_none_or(|w| got.as_deref() == Some(w));
    o.type_ == e.type_
        && named(&o.kind, &e.kind)
        && named(&o.place, &e.place)
        && named(&o.npc, &e.npc)
        && named(&o.crop, &e.crop)
        && named(&o.pack, &e.pack)
        && named(&o.outpost, &e.outpost)
        && named(&o.vehicle, &e.vehicle)
}

/// Counts toward each objective of the quest's step that `pick` names and isn't done yet, and
/// moves on once they all are.
fn count_toward(life: &mut Life, id: &str, pick: impl Fn(&Objective) -> bool, amount: f64) {
    let Some(i) = quest_active(life, id) else { return };
    let p = &mut life.state.quests.active[i];
    let Some(step) = step_of(quest_def(id), p.step) else { return };
    let mut changed = false;
    for (k, o) in step.objectives.iter().enumerate() {
        let target = objective_target(o);
        // Counts always cover the step's objectives (catch_up fills them in); a short list from
        // a damaged save counts from zero.
        let have = p.counts.get(k).copied().unwrap_or(0.0);
        if have >= target || !pick(o) {
            continue;
        }
        if p.counts.len() <= k {
            p.counts.resize(k + 1, 0.0);
        }
        p.counts[k] = js_min(target, have + amount);
        changed = true;
    }
    if changed && step.objectives.iter().enumerate().all(|(k, o)| p.counts.get(k).is_some_and(|n| *n >= objective_target(o))) {
        advance(life, id);
    }
}

pub fn notify_quests(life: &mut Life, e: &QuestEvent) {
    for id in active_ids(life) {
        count_toward(life, &id, |o| matches(o, e), e.amount.unwrap_or(1.0));
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
        // A milestone has nobody to hand it to: it's done the moment its steps are.
        if is_milestone(q) && complete(life, id) {
            return;
        }
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
        // Each quest measures its own places, with its own reach and height: the foot of the
        // Windspire is the spire for one quest and not yet its top for another.
        let zone = life.zone;
        let at = |o: &Objective| {
            o.type_ == "reach"
                && given(&o.place)
                    .and_then(|place| zone.recipe.places.iter().find(|pl| pl.id == place))
                    .is_some_and(|pl| js_hypot(x - pl.x, z - pl.z) <= o.r.unwrap_or(20.0) && y >= o.min_y.unwrap_or(f64::NEG_INFINITY))
        };
        for id in active_ids(life) {
            count_toward(life, &id, &at, 1.0);
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
        assert!(events.contains(&LifeEvent::Toast {
            text: "✔ Landfall complete - 1 skill point, 50c, Scarecrow, 8 Sunroot Seeds, 6 Barley Seeds".into(),
            kind: "quest".into()
        }));
        // Done, and then the milestones it opens start, quietly.
        let done = events.iter().position(|e| *e == LifeEvent::Quest { id: "landfall".into(), what: "done".into() }).expect("done");
        let after: Vec<LifeEvent> = ["wayfarer", "slimeHunter", "practisedHand"].map(|id| LifeEvent::Quest { id: id.into(), what: "accepted".into() }).into();
        assert_eq!(events[done + 1..], after);
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
        // The Wayfarer milestone wants the spire too: from further out, at any height.
        let spire = quest_def("wayfarer").steps[0].objectives.iter().position(|o| o.place.as_deref() == Some("windspire")).unwrap();
        let wayfarer_has_it = |life: &Life| life.state.quests.active[quest_active(life, "wayfarer").unwrap()].counts[spire] == 1.0;
        assert!(!wayfarer_has_it(&life));
        // Near enough, but not up on top: that's the spire for Wayfarer, and not yet for Wings.
        sim.player.pos.x = top.x + 20.0;
        sim.player.pos.z = top.z;
        sim.player.pos.y = 100.0;
        life.state.clock = 0.25;
        step_quests(&mut life, &mut sim);
        assert_eq!(step(&life, "wings"), 0);
        assert!(wayfarer_has_it(&life));
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
        assert_eq!(said.last().unwrap(), "✔ First Flight complete - 1 skill point, 60c, 1 seal");
        // Sky Legs opens with it, quietly, and counts the gliding from here on.
        assert!(quest_active(&life, "skyLegs").is_some());
    }

    #[test]
    fn a_milestone_an_event_finishes_still_leaves_that_event_to_the_rest() {
        let (mut life, _, _) = island(0.0);
        life.state.quests.done.extend(["landfall", "patch", "harvest", "packwright", "westward"].map(String::from));
        // Pack Mule one delivery short, then Wheels on its deliveries to Westwatch.
        life.state.quests.active = vec![
            QuestProgress { id: "packMule".into(), step: 0, counts: vec![4.0] },
            QuestProgress { id: "wheels".into(), step: 2, counts: vec![0.0] },
        ];
        toasts(&mut life);
        life.notify(QuestEvent { outpost: Some("westwatch".into()), pack: Some("flaxBale".into()), ..QuestEvent::new("deliver") });
        assert!(quest_done(&life, "packMule"));
        assert_eq!(life.state.quests.active[quest_active(&life, "wheels").unwrap()].counts, [1.0], "the delivery counted for Wheels too");
        assert_eq!(toasts(&mut life), ["✔ Milestone: Pack Mule - 1 skill point"]);
        // A place reached the same way: Wayfarer, needing only the spire, finishes as it's
        // measured, and Wings, after it in the list, still measures the top for itself.
        let (mut life, mut world, mut p) = island(0.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        talk(&mut life, "hollis");
        assert!(complete(&mut life, "landfall"));
        assert!(accept(&mut life, "wings"));
        life.state.quests.active.retain(|q| q.id == "wayfarer" || q.id == "wings");
        let w = quest_active(&life, "wayfarer").unwrap();
        let spire = quest_def("wayfarer").steps[0].objectives.iter().position(|o| o.place.as_deref() == Some("windspire")).unwrap();
        for (k, c) in life.state.quests.active[w].counts.iter_mut().enumerate() {
            *c = if k == spire { 0.0 } else { 1.0 };
        }
        let top = life.zone.recipe.places.iter().find(|pl| pl.id == "windspire").unwrap().clone();
        (sim.player.pos.x, sim.player.pos.y, sim.player.pos.z) = (top.x, 120.0, top.z);
        life.state.clock = 0.25;
        toasts(&mut life);
        step_quests(&mut life, &mut sim);
        assert!(quest_done(&life, "wayfarer"));
        assert_eq!(step(&life, "wings"), 1);
        assert_eq!(toasts(&mut life), ["✔ Milestone: Wayfarer - 1 skill point", "Wings over the Windspire: Speak with Ysolde Windward at the glider launch"]);
        // A defeat or a level is only counted by what names it.
        assert!(matches(&Objective { type_: "defeat".into(), kind: Some("slime".into()), ..Default::default() }, &QuestEvent { kind: Some("slime".into()), ..QuestEvent::new("defeat") }));
        assert!(!matches(&Objective { type_: "defeat".into(), kind: Some("slime".into()), ..Default::default() }, &QuestEvent { kind: Some("slimelet".into()), ..QuestEvent::new("defeat") }));
        assert!(matches(&Objective { type_: "defeat".into(), ..Default::default() }, &QuestEvent { kind: Some("slimelet".into()), ..QuestEvent::new("defeat") }));
        assert!(!matches(&Objective { type_: "skillLevel".into(), ..Default::default() }, &QuestEvent::new("defeat")));
    }

    #[test]
    fn a_milestone_finished_while_catching_up_leaves_the_rest_to_catch_up() {
        let (mut life, _, _) = island(0.0);
        life.state.quests.done.extend(["landfall", "patch", "livestock", "firstFlight", "westward"].map(String::from));
        // Rancher waiting on three animals that are already in the pens, and the house quest on a
        // plot already claimed and half built.
        life.state.quests.active = vec![
            QuestProgress { id: "rancher".into(), step: 0, counts: vec![0.0] },
            QuestProgress { id: "home".into(), step: 0, counts: vec![0.0] },
        ];
        let chick = || Some(Plant { crop: "chick".into(), animal: Some(true), ..Default::default() });
        life.state.scarecrows.push(Scarecrow { id: 9, x: 0.0, z: 0.0, rot: 0.0, cells: vec![chick(), chick(), chick(), None] });
        life.state.houses.push(crate::life::state::House { id: 5, plot: "rise-1".into(), blueprint: "cottage".into(), stage: 2, ..Default::default() });
        toasts(&mut life);
        start_quests(&mut life);
        assert!(quest_done(&life, "rancher"));
        let p = &life.state.quests.active[quest_active(&life, "home").unwrap()];
        assert_eq!((p.step, p.counts.as_slice()), (1, [2.0].as_slice()));
        assert!(toasts(&mut life).contains(&"✔ Milestone: Rancher - 1 skill point".to_string()));
        // And what became available started too.
        for id in ["wayfarer", "slimeHunter", "practisedHand", "skyLegs", "packMule"] {
            assert!(quest_active(&life, id).is_some(), "{id}");
        }
    }

    #[test]
    fn a_quest_given_up_goes_with_its_progress_and_its_giver_offers_it_again() {
        let (mut life, _, _) = island(0.0);
        // Not one that starts by itself, a milestone, or one you haven't taken.
        assert!(!abandon(&mut life, "landfall"), "Landfall starts by itself");
        talk(&mut life, "hollis");
        assert!(complete(&mut life, "landfall"));
        assert!(!abandon(&mut life, "wayfarer"), "a milestone");
        assert!(!abandon(&mut life, "wings"), "not taken");
        assert!(!abandon(&mut life, "no-such-quest"));
        // Patch, part done, given up: gone with its progress, and Hollis offers it again.
        assert!(accept(&mut life, "patch"));
        life.notify(QuestEvent::new("placeScarecrow"));
        life.notify(QuestEvent::new("plant"));
        assert_eq!(step(&life, "patch"), 1);
        life.drain_events();
        assert!(abandon(&mut life, "patch"));
        assert!(quest_active(&life, "patch").is_none() && !quest_done(&life, "patch"));
        let events = life.drain_events();
        assert_eq!(
            events,
            [LifeEvent::Quest { id: "patch".into(), what: "abandoned".into() }, LifeEvent::Toast { text: "Quest abandoned: A Patch of Earth".into(), kind: "info".into() }]
        );
        assert!(ids(&quests_at(&life, "hollis").0).contains(&"patch".to_string()));
        assert!(accept(&mut life, "patch"));
        let p = &life.state.quests.active[quest_active(&life, "patch").unwrap()];
        assert_eq!((p.step, p.counts.as_slice()), (0, [0.0].as_slice()));
        // One that handed you something takes it back; once you've used that, it can't be given up.
        life.state.quests.active.retain(|q| q.id != "patch");
        life.state.quests.done.push("patch".into());
        assert!(accept(&mut life, "livestock"));
        assert_eq!(life.count("animal.chick"), 1);
        assert!(abandon(&mut life, "livestock"));
        assert_eq!(life.count("animal.chick"), 0);
        assert!(accept(&mut life, "livestock"));
        life.take("animal.chick", 1);
        toasts(&mut life);
        assert!(!abandon(&mut life, "livestock"));
        assert_eq!(toasts(&mut life), ["You've used the Chick it gave you, so it can't be given up"]);
        assert!(quest_active(&life, "livestock").is_some());
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
