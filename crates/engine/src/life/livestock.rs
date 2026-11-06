//! Farm animals in scarecrow plots, raised in plot cells like crops: a
//! chick, lamb or calf grows up only while it is fed, and once grown it lays, grows fleece or gives
//! milk again and again - also only while fed. A hungry animal simply waits for you; nothing dies
//! of neglect on Emberholm.

use super::content::{animal_def, item_def};
use super::farming::{plant_at, plant_at_mut, scarecrow_index};
use super::state::Plant;
use super::{Life, LifeEvent, QuestEvent};
use crate::jsmath::{js_max, js_min};

pub fn is_animal(p: Option<&Plant>) -> bool {
    p.is_some_and(|p| p.is_animal())
}

pub fn hungry(life: &Life, p: &Plant) -> bool {
    p.fed_until.unwrap_or(0.0) <= life.state.clock
}

pub fn grown_up(p: &Plant) -> bool {
    p.growth >= 1.0
}

pub fn produce_ready(p: &Plant) -> bool {
    grown_up(p) && p.produce.unwrap_or(0.0) >= 1.0
}

/// Advances growth and produce for `seconds`, but only the part of it the animal was fed for.
/// `clock` is the island's clock now. Returns whether it grew up or became ready.
pub fn step_animal(clock: f64, p: &mut Plant, seconds: f64) -> bool {
    let def = animal_def(&p.crop);
    let fed_for = js_max(0.0, js_min(seconds, p.fed_until.unwrap_or(0.0) - (clock - seconds)));
    if fed_for <= 0.0 {
        return false;
    }
    let was_grown = grown_up(p);
    let was_ready = produce_ready(p);
    if !was_grown {
        p.growth = js_min(1.0, p.growth + fed_for / def.grow_seconds);
    } else {
        p.produce = Some(js_min(1.0, p.produce.unwrap_or(0.0) + fed_for / def.produce_seconds));
    }
    was_grown != grown_up(p) || was_ready != produce_ready(p)
}

/// Puts a young animal in cell `idx` of the scarecrow with id `sc`.
pub fn raise(life: &mut Life, sc: i64, idx: usize, item: &str) -> bool {
    let def = item_def(item);
    let Some(animal) = def.raises.as_deref().filter(|a| !a.is_empty()) else { return false };
    let Some(k) = scarecrow_index(life, sc) else { return false };
    // An empty cell (one past the end of the plot is nowhere to put it).
    if !matches!(life.state.scarecrows[k].cells.get(idx), Some(None)) {
        return false;
    }
    if !life.take(item, 1) {
        return false;
    }
    // Arrives fed, so it starts growing straight away.
    let fed_until = life.state.clock + animal_def(animal).feed_seconds;
    life.state.scarecrows[k].cells[idx] = Some(Plant {
        crop: animal.to_string(),
        growth: 0.0,
        watered: false,
        picked: false,
        animal: Some(true),
        fed_until: Some(fed_until),
        produce: Some(0.0),
    });
    life.revision += 1;
    life.notify(QuestEvent { crop: Some(animal.to_string()), ..QuestEvent::new("raise") });
    true
}

/// Feeds the animal in cell `idx` of the scarecrow with id `sc`.
pub fn feed(life: &mut Life, sc: i64, idx: usize) -> bool {
    let Some(p) = plant_at(life, sc, idx) else { return false };
    let def = animal_def(&p.crop);
    if life.count(&def.feed) < def.feed_n {
        life.toast(format!("Needs {} {} to feed (you have {})", def.feed_n, item_def(&def.feed).name, life.count(&def.feed)), "bad");
        return false;
    }
    life.take(&def.feed, def.feed_n);
    let clock = life.state.clock;
    if let Some(p) = plant_at_mut(life, sc, idx) {
        p.fed_until = Some(js_max(p.fed_until.unwrap_or(0.0), clock) + def.feed_seconds);
    }
    life.revision += 1;
    true
}

/// Collects eggs, wool or milk from the animal in cell `idx` of the scarecrow with id `sc`; the
/// effect shows at (x, y, z).
pub fn collect(life: &mut Life, sc: i64, idx: usize, x: f64, y: f64, z: f64) -> bool {
    let Some(p) = plant_at(life, sc, idx) else { return false };
    if !produce_ready(p) {
        return false;
    }
    let crop = p.crop.clone();
    let def = animal_def(&crop);
    if !life.has_room(&def.produce, def.yield_[1]) {
        life.toast("Your bag is full", "bad");
        return false;
    }
    if !life.afford(0.0, 0.0, def.collect_labor, &def.verb.to_lowercase()) {
        return false;
    }
    let n = life.rand_int(def.yield_[0], def.yield_[1]);
    life.give(&def.produce, n, false);
    if let Some(p) = plant_at_mut(life, sc, idx) {
        p.produce = Some(0.0);
    }
    life.state.stats.harvested += 1.0;
    life.revision += 1;
    life.emit(LifeEvent::Harvest { x, y, z });
    life.notify(QuestEvent { crop: Some(crop), ..QuestEvent::new("harvest") });
    true
}

// The expected numbers here are what the TypeScript copy of the rules gave for the same steps, while
// there was one.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::farming::add_scarecrow;
    use crate::life::farming::grow_for;
    use crate::life::farming::tests::{got, island};
    use crate::life::state::Stack;
    use crate::open::Sim;

    #[test]
    fn an_animal_grows_only_for_the_time_it_was_fed() {
        let mut chick = Plant { crop: "chicken".into(), animal: Some(true), fed_until: Some(100.0), produce: Some(0.0), ..Default::default() };
        // Fed through the whole stretch.
        assert!(!step_animal(50.0, &mut chick, 10.0));
        assert_eq!(chick.growth, 10.0 / 150.0);
        // Fed for the first half of it.
        step_animal(110.0, &mut chick, 20.0);
        assert_eq!(chick.growth, 10.0 / 150.0 + 10.0 / 150.0);
        // Hungry: it waits for you.
        assert!(!step_animal(200.0, &mut chick, 20.0));
        assert_eq!(chick.growth, 10.0 / 150.0 + 10.0 / 150.0);
        // Growing up, and later having eggs ready, are both changes worth redrawing.
        chick.fed_until = Some(1000.0);
        assert!(step_animal(400.0, &mut chick, 300.0));
        assert_eq!((chick.growth, chick.produce), (1.0, Some(0.0)));
        assert!(step_animal(600.0, &mut chick, 200.0));
        assert!(produce_ready(&chick) && chick.produce == Some(1.0));
        assert!(!step_animal(700.0, &mut chick, 100.0), "ready already");
    }

    #[test]
    fn a_chick_raised_fed_and_collected_from() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        let sc = add_scarecrow(&mut life, &mut sim, -208.0, -240.0, 0.0);
        life.give("animal.chick", 1, true);
        assert!(raise(&mut life, sc, 3, "animal.chick"));
        // It arrives fed.
        let chick = Plant { crop: "chicken".into(), animal: Some(true), fed_until: Some(300.0), produce: Some(0.0), ..Default::default() };
        assert_eq!(plant_at(&life, sc, 3), Some(&chick));
        assert!(is_animal(plant_at(&life, sc, 3)) && !is_animal(plant_at(&life, sc, 4)));
        life.state.clock += 400.0;
        grow_for(&mut life, 400.0);
        let grown = plant_at(&life, sc, 3).unwrap();
        assert!(grown_up(grown) && hungry(&life, grown) && !produce_ready(grown));
        assert!(!feed(&mut life, sc, 3));
        assert_eq!(life.drain_events(), vec![LifeEvent::Toast { text: "Needs 2 Barley to feed (you have 0)".into(), kind: "bad".into() }]);
        life.give("barley", 5, true);
        assert!(feed(&mut life, sc, 3));
        assert_eq!(plant_at(&life, sc, 3).unwrap().fed_until, Some(700.0));
        life.state.clock += 300.0;
        grow_for(&mut life, 300.0);
        assert!(produce_ready(plant_at(&life, sc, 3).unwrap()));
        life.drain_events();
        assert!(collect(&mut life, sc, 3, 1.0, 2.0, 3.0));
        assert_eq!(life.state.bag, vec![Stack { item: "barley".into(), n: 3 }, Stack { item: "egg".into(), n: 3 }]);
        assert_eq!(life.drain_events(), vec![got(3, "egg"), LifeEvent::Harvest { x: 1.0, y: 2.0, z: 3.0 }]);
        assert_eq!(plant_at(&life, sc, 3).unwrap().produce, Some(0.0));
        assert!(!collect(&mut life, sc, 3, 1.0, 2.0, 3.0), "nothing ready yet");
        life.give("animal.chick", 1, true);
        assert!(!raise(&mut life, sc, 3, "animal.chick"), "the cell is taken");
        assert!(!raise(&mut life, sc, 3, "seed.barley") && !raise(&mut life, sc, 99, "animal.chick") && !feed(&mut life, sc, 99));
    }
}
