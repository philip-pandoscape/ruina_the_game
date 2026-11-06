//! Houses on the plots at Hearthside Rise (src/sim/life/housing.ts).
//!
//! A blueprint claims an empty plot; then the house goes up a stage at a time as you haul each
//! stage's material packs to the site - on your back or by cart - and put in the labor. Finished,
//! it is yours: a bed that restores labor faster, a chest, and a tax bill to keep paid.

use std::collections::BTreeMap;

use super::content::{blueprint_def, format_coins, has_blueprint, js_max, pack_def, structure_def, Spot, StageDef};
use super::state::House;
use super::trade::{carried, consume_carried};
use super::{Life, LifeEvent, QuestEvent};
use crate::open::zone::{rect, to_world, HousePlot};
use crate::open::Sim;

pub const DAY: f64 = 86400.0;

/// Where the house stands inside its plot: toward the back, leaving a front yard.
pub const HOUSE_SETBACK: f64 = -2.5;

/// What a stage still needs, pack by pack (houses and ships).
#[derive(Clone, Debug, PartialEq)]
pub struct Need {
    pub pack: String,
    pub need: i64,
    pub have: i64,
}

pub fn plot_def(life: &Life, plot: &str) -> Option<&'static HousePlot> {
    life.zone.recipe.house_plots.iter().find(|p| p.id == plot)
}

/// Index of the house on this plot in life.state.houses, if any.
pub fn house_on(life: &Life, plot: &str) -> Option<usize> {
    life.state.houses.iter().position(|h| h.plot == plot)
}

/// Index of the house with this id in life.state.houses.
fn house_index(life: &Life, id: i64) -> Option<usize> {
    life.state.houses.iter().position(|h| h.id == id)
}

/// The stage a house is on (None once it is finished).
fn stage_of(stages: &'static [StageDef], stage: i64) -> Option<&'static StageDef> {
    usize::try_from(stage).ok().and_then(|s| stages.get(s))
}

/// The house's own position and facing in the world: (x, z, rot).
pub fn house_pose(life: &Life, h: &House) -> (f64, f64, f64) {
    // A house only ever stands on one of the zone's plots; one on a plot that has since gone
    // (where the TypeScript would throw) stands at the origin.
    let (px, pz, rot) = plot_def(life, &h.plot).map_or((0.0, 0.0, 0.0), |p| (p.x, p.z, p.rot));
    let (ox, oz) = to_world(0.0, HOUSE_SETBACK, rot);
    (px + ox, pz + oz, rot)
}

pub fn is_complete(h: &House) -> bool {
    h.stage >= blueprint_def(&h.blueprint).stages.len() as i64
}

pub fn still_needs(h: &House) -> Vec<Need> {
    let Some(stage) = stage_of(&blueprint_def(&h.blueprint).stages, h.stage) else { return Vec::new() };
    stage.needs.iter().map(|(pack, need)| Need { pack: pack.to_string(), need, have: h.delivered.get(pack).copied().unwrap_or(0) }).collect()
}

pub fn stage_ready(h: &House) -> bool {
    still_needs(h).iter().all(|n| n.have >= n.need)
}

pub fn place_house(life: &mut Life, sim: &mut Sim, plot: &str, item: &str) -> bool {
    // Only the zone's plots can be built on (the TypeScript would throw part way through).
    if plot_def(life, plot).is_none() {
        return false;
    }
    if house_on(life, plot).is_some() {
        return false;
    }
    if let Some(owner) = life.plot_owners.get(plot).filter(|o| !o.is_empty()).cloned() {
        life.toast(format!("That plot is {owner}'s"), "bad");
        return false;
    }
    if !life.state.houses.is_empty() {
        life.toast("One house per settler on Emberholm (for now)", "bad");
        return false;
    }
    let bp_id = item.replacen("blueprint.", "", 1);
    // The TypeScript throws on a blueprint that doesn't exist.
    if !has_blueprint(&bp_id) {
        return false;
    }
    let bp = blueprint_def(&bp_id);
    if !life.take(item, 1) {
        return false;
    }
    let id = life.next_id();
    let tax_paid_until = life.state.clock + bp.grace_days * DAY;
    life.state.houses.push(House { id, plot: plot.to_string(), blueprint: bp.id.clone(), stage: 0, delivered: BTreeMap::new(), storage: Vec::new(), tax_paid_until });
    let i = life.state.houses.len() - 1;
    add_house_colliders(life, sim, &life.state.houses[i]);
    life.revision += 1;
    let first = bp.stages.first().map(|s| s.name.to_lowercase()).unwrap_or_default();
    life.toast(format!("📜 Plot claimed! Haul the {first} materials here to begin."), "quest");
    life.notify(QuestEvent::new("placeHouse"));
    true
}

/// Hands the pack on your back to the house with this id, if its stage wants it.
pub fn deliver_material(life: &mut Life, sim: &mut Sim, house: i64) -> bool {
    let Some(hi) = house_index(life, house) else { return false };
    let Some(pi) = carried(life, sim) else { return false };
    let pack = life.state.packs[pi].def.clone();
    let h = &life.state.houses[hi];
    let Some(want) = still_needs(h).into_iter().find(|n| n.pack == pack && n.have < n.need) else {
        let what = stage_of(&blueprint_def(&h.blueprint).stages, h.stage).map_or_else(|| "house".to_string(), |s| s.name.to_lowercase());
        life.toast(format!("The {what} does not need a {}", pack_def(&pack).name), "bad");
        return false;
    };
    life.state.houses[hi].delivered.insert(pack.clone(), want.have + 1);
    consume_carried(life, sim);
    life.revision += 1;
    let def = pack_def(&pack);
    life.toast(format!("Delivered {} {} ({}/{})", def.icon, def.name, want.have + 1, want.need), "good");
    true
}

pub fn build_stage(life: &mut Life, sim: &mut Sim, house: i64) -> bool {
    let Some(hi) = house_index(life, house) else { return false };
    let h = &life.state.houses[hi];
    let bp = blueprint_def(&h.blueprint);
    let Some(stage) = stage_of(&bp.stages, h.stage) else { return false };
    if !stage_ready(h) {
        return false;
    }
    if !life.afford(0.0, 0.0, stage.labor, &format!("build the {}", stage.name.to_lowercase())) {
        return false;
    }
    let h = &mut life.state.houses[hi];
    h.stage += 1;
    h.delivered = BTreeMap::new();
    life.state.stats.built += 1.0;
    add_house_colliders(life, sim, &life.state.houses[hi]);
    life.revision += 1;
    let h = &life.state.houses[hi];
    let (x, z, _) = house_pose(life, h);
    let (id, now, complete) = (h.id, h.stage, is_complete(h));
    life.emit(LifeEvent::Build { house: id, stage: now, x, z });
    life.notify(QuestEvent::new("buildStage"));
    if complete {
        life.toast(format!("🏡 Your {} is finished. Welcome home.", bp.name.to_lowercase()), "quest");
    } else {
        let next = stage_of(&bp.stages, now).map_or("", |s| s.name.as_str());
        life.toast(format!("🔨 {} done. Next: {next}.", stage.name), "good");
    }
    true
}

/// The house's solid parts as far as it has been built (each piece once per owner and house): the
/// floor from the foundation up, the walls (with their doorway) once they are raised. The world is
/// shared by a channel and house ids are only unique per character, so pieces are remembered in
/// `sim.world.added` under the owner's id as well as the house's.
pub fn add_house_colliders(life: &Life, sim: &mut Sim, h: &House) {
    let hf = sim.terrain();
    let def = structure_def(&blueprint_def(&h.blueprint).structure);
    let (px, pz, rot) = house_pose(life, h);
    let y = hf.height(px, pz);
    let owner = sim.owner;
    let key = |what: &str| format!("{owner}:{}:{what}", h.id);
    if sim.world.added.insert(key("ground")) {
        // Keep the footprint (and a metre round it) clear of trees and scarecrows.
        let clear = &mut sim.world.clear;
        let mut a = -def.w / 2.0 - 1.0;
        while a <= def.w / 2.0 + 1.0 {
            let mut b = -def.d / 2.0 - 1.0;
            while b <= def.d / 2.0 + 1.0 {
                let (ox, oz) = to_world(a, b, rot);
                let i = ((px + ox - hf.min) / hf.cell).floor();
                let j = ((pz + oz - hf.min) / hf.cell).floor();
                if i >= 0.0 && j >= 0.0 && i < hf.cells as f64 && j < hf.cells as f64 {
                    if let Some(c) = clear.get_mut(j as usize * hf.cells + i as usize) {
                        *c = 1;
                    }
                }
                b += hf.cell / 2.0;
            }
            a += hf.cell / 2.0;
        }
    }
    if h.stage >= 1 && sim.world.added.insert(key("floor")) {
        sim.world.index.add_deck(rect(px, pz, def.w / 2.0, def.d / 2.0, rot, y + def.floor.unwrap_or(0.25)));
    }
    if h.stage >= 3 && sim.world.added.insert(key("walls")) {
        let t = def.wall.unwrap_or(0.3);
        let hw = def.w / 2.0;
        let hd = def.d / 2.0;
        let door = def.door.unwrap_or(1.4) / 2.0;
        let top = y + def.h;
        let index = &mut sim.world.index;
        let mut add = |lx: f64, lz: f64, w: f64, d: f64| {
            let (ox, oz) = to_world(lx, lz, rot);
            index.add_box(rect(px + ox, pz + oz, w / 2.0, d / 2.0, rot, top));
        };
        add(0.0, -hd + t / 2.0, def.w, t);
        add(hw - t / 2.0, 0.0, t, def.d);
        add(-hw + t / 2.0, 0.0, t, def.d);
        let seg = hw - door;
        add(door + seg / 2.0, hd - t / 2.0, seg, t);
        add(-door - seg / 2.0, hd - t / 2.0, seg, t);
    }
}

/// A point inside the house ("bed", "chest") in world space: (x, z).
pub fn interior_point(life: &Life, h: &House, what: &str) -> (f64, f64) {
    let def = structure_def(&blueprint_def(&h.blueprint).structure);
    let p = def.interior.as_ref().and_then(|spots| spots.get(what)).copied().unwrap_or(Spot { x: 0.0, z: 0.0 });
    let (x, z, rot) = house_pose(life, h);
    let (ox, oz) = to_world(p.x, p.z, rot);
    (x + ox, z + oz)
}

/// (owed, due_in).
pub fn tax_due(life: &Life, h: &House) -> (f64, f64) {
    let bp = blueprint_def(&h.blueprint);
    let due_in = h.tax_paid_until - life.state.clock;
    (bp.tax_per_day * 7.0, due_in)
}

pub fn pay_tax(life: &mut Life, house: i64) -> bool {
    let Some(hi) = house_index(life, house) else { return false };
    let bp = blueprint_def(&life.state.houses[hi].blueprint);
    let week = bp.tax_per_day * 7.0;
    if !life.afford(week, 0.0, 0.0, "pay the property tax") {
        return false;
    }
    let clock = life.state.clock;
    let h = &mut life.state.houses[hi];
    h.tax_paid_until = js_max(h.tax_paid_until, clock) + 7.0 * DAY;
    life.toast(format!("Paid a week's property tax: {}", format_coins(week)), "coin");
    true
}

pub fn step_housing(_life: &mut Life) {
    // Taxes accrue by the clock; nothing needs doing per frame yet. Demolition of neglected houses
    // is designed (see the design doc) but deliberately not switched on yet.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::trade::make_pack;
    use crate::life::trade::testing::{island, toasts};

    /// A material pack onto your back and into the house's site.
    fn haul(life: &mut Life, sim: &mut Sim, house: i64, pack: &str) -> bool {
        sim.player.pack = make_pack(life, pack, "x");
        deliver_material(life, sim, house)
    }

    #[test]
    fn a_house_goes_up_stage_by_stage_and_is_made_solid_once() {
        let (mut life, mut world, mut p) = island(1000.0);
        let (decks, boxes) = (world.index.decks.len(), world.index.boxes.len());
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 7 };
        life.plot_owners.insert("rise-2".into(), "Brann".into());
        life.give("blueprint.cottage", 1, true);
        toasts(&mut life);
        assert!(!place_house(&mut life, &mut sim, "rise-2", "blueprint.cottage"));
        assert_eq!(toasts(&mut life), ["That plot is Brann's"]);
        assert!(!place_house(&mut life, &mut sim, "nowhere", "blueprint.cottage"));
        assert!(!place_house(&mut life, &mut sim, "rise-1", "blueprint.villa"));
        assert!(place_house(&mut life, &mut sim, "rise-1", "blueprint.cottage"));
        let h = life.state.houses[0].clone();
        assert_eq!((h.plot.as_str(), h.blueprint.as_str(), h.stage, h.tax_paid_until), ("rise-1", "cottage", 0, 7.0 * DAY));
        assert_eq!(life.count("blueprint.cottage"), 0);
        assert_eq!(toasts(&mut life), ["📜 Plot claimed! Haul the foundation materials here to begin."]);
        // The ground is cleared at once; nothing is solid yet.
        let hf = sim.terrain();
        let (x, z, _) = house_pose(&life, &h);
        let cell = ((z - hf.min) / hf.cell).floor() as usize * hf.cells + ((x - hf.min) / hf.cell).floor() as usize;
        assert_eq!(sim.world.clear[cell], 1);
        assert!(sim.world.added.contains(&format!("7:{}:ground", h.id)));
        assert_eq!((sim.world.index.decks.len(), sim.world.index.boxes.len()), (decks, boxes));
        // One each, and none on a plot that's built on.
        life.give("blueprint.cottage", 1, true);
        toasts(&mut life);
        assert!(!place_house(&mut life, &mut sim, "rise-3", "blueprint.cottage"));
        assert_eq!(toasts(&mut life), ["One house per settler on Emberholm (for now)"]);
        assert!(!place_house(&mut life, &mut sim, "rise-1", "blueprint.cottage"));
        assert_eq!(life.count("blueprint.cottage"), 1);
        // The foundation wants stone, not lumber; the pack you offered stays on your back.
        assert!(!haul(&mut life, &mut sim, h.id, "lumberBundle"));
        assert_eq!(toasts(&mut life), ["The foundation does not need a Lumber Bundle"]);
        assert_ne!(sim.player.pack, 0);
        consume_carried(&mut life, &mut sim);
        assert!(!build_stage(&mut life, &mut sim, h.id), "nothing delivered yet");
        assert!(haul(&mut life, &mut sim, h.id, "stoneBlock"));
        assert_eq!(toasts(&mut life), ["Delivered 🧱 Stone Block (1/2)"]);
        assert_eq!(still_needs(&life.state.houses[0]), [Need { pack: "stoneBlock".into(), need: 2, have: 1 }]);
        assert!(haul(&mut life, &mut sim, h.id, "stoneBlock"));
        assert!(stage_ready(&life.state.houses[0]));
        assert!(!haul(&mut life, &mut sim, h.id, "stoneBlock"), "it has all it needs");
        consume_carried(&mut life, &mut sim);
        toasts(&mut life);
        // The foundation: labor spent, a floor to stand on.
        assert!(build_stage(&mut life, &mut sim, h.id));
        let built = &life.state.houses[0];
        assert_eq!((built.stage, built.delivered.len(), life.state.labor, life.state.stats.built), (1, 0, 780.0, 1.0));
        assert_eq!((sim.world.index.decks.len(), sim.world.index.boxes.len()), (decks + 1, boxes));
        let floor = sim.world.index.decks[decks];
        let def = structure_def("cottage");
        assert_eq!((floor.x, floor.z, floor.hw, floor.hd), (x, z, def.w / 2.0, def.d / 2.0));
        assert_eq!(floor.top, hf.height(x, z) + def.floor.unwrap());
        let events = life.drain_events();
        assert!(events.contains(&LifeEvent::Build { house: h.id, stage: 1, x, z }));
        assert!(events.contains(&LifeEvent::Toast { text: "🔨 Foundation done. Next: Frame.".into(), kind: "good".into() }));
        // Asking again adds nothing.
        add_house_colliders(&life, &mut sim, &life.state.houses[0].clone());
        assert_eq!(sim.world.index.decks.len(), decks + 1);
        // Frame, walls (and their five pieces), roof.
        for pack in ["lumberBundle", "lumberBundle"] {
            assert!(haul(&mut life, &mut sim, h.id, pack));
        }
        assert!(build_stage(&mut life, &mut sim, h.id));
        assert_eq!(sim.world.index.boxes.len(), boxes);
        for pack in ["lumberBundle", "stoneBlock", "lumberBundle"] {
            assert!(haul(&mut life, &mut sim, h.id, pack));
        }
        assert!(build_stage(&mut life, &mut sim, h.id));
        assert_eq!(sim.world.index.boxes.len(), boxes + 5);
        assert!(sim.world.index.boxes[boxes..].iter().all(|b| b.top == hf.height(x, z) + def.h));
        for pack in ["ironCrate", "lumberBundle"] {
            assert!(haul(&mut life, &mut sim, h.id, pack));
        }
        toasts(&mut life);
        assert!(build_stage(&mut life, &mut sim, h.id));
        assert!(is_complete(&life.state.houses[0]));
        assert_eq!(toasts(&mut life), ["🏡 Your cottage is finished. Welcome home."]);
        assert_eq!((life.state.labor, life.state.stats.built), (700.0, 4.0));
        assert_eq!((sim.world.index.decks.len(), sim.world.index.boxes.len()), (decks + 1, boxes + 5));
        assert!(!build_stage(&mut life, &mut sim, h.id), "nothing left to build");
        assert!(still_needs(&life.state.houses[0]).is_empty());
        assert!(!haul(&mut life, &mut sim, h.id, "stoneBlock"));
        assert_eq!(toasts(&mut life), ["The house does not need a Stone Block"]);
        assert!(!build_stage(&mut life, &mut sim, 999));
    }

    #[test]
    fn another_settlers_house_with_the_same_id_is_solid_too() {
        let (mut mine, mut world, mut p) = island(0.0);
        let (mut theirs, _, mut q) = island(0.0);
        let (decks, boxes) = (world.index.decks.len(), world.index.boxes.len());
        mine.give("blueprint.cottage", 1, true);
        theirs.give("blueprint.cottage", 1, true);
        assert!(place_house(&mut mine, &mut Sim { player: &mut p, world: &mut world, owner: 1 }, "rise-1", "blueprint.cottage"));
        assert!(place_house(&mut theirs, &mut Sim { player: &mut q, world: &mut world, owner: 2 }, "rise-5", "blueprint.cottage"));
        assert_eq!(mine.state.houses[0].id, theirs.state.houses[0].id);
        mine.state.houses[0].stage = 3;
        theirs.state.houses[0].stage = 3;
        add_house_colliders(&mine, &mut Sim { player: &mut p, world: &mut world, owner: 1 }, &mine.state.houses[0]);
        add_house_colliders(&theirs, &mut Sim { player: &mut q, world: &mut world, owner: 2 }, &theirs.state.houses[0]);
        add_house_colliders(&theirs, &mut Sim { player: &mut q, world: &mut world, owner: 2 }, &theirs.state.houses[0]);
        assert_eq!((world.index.decks.len(), world.index.boxes.len()), (decks + 2, boxes + 10));
    }

    #[test]
    fn the_bed_and_chest_stand_where_the_structure_puts_them_and_tax_is_paid_by_the_week() {
        let (mut life, mut world, mut p) = island(400.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        life.give("blueprint.cottage", 1, true);
        assert!(place_house(&mut life, &mut sim, "rise-5", "blueprint.cottage"));
        let h = life.state.houses[0].clone();
        // rise-5 faces +Z (rot 0): local points are world offsets from the house.
        let plot = plot_def(&life, "rise-5").unwrap();
        assert_eq!(house_pose(&life, &h), (plot.x, plot.z - 2.5, 0.0));
        let bed = structure_def("cottage").interior.as_ref().unwrap()["bed"];
        assert_eq!(interior_point(&life, &h, "bed"), (plot.x + bed.x, plot.z - 2.5 + bed.z));
        assert_eq!(interior_point(&life, &h, "nowhere"), (plot.x, plot.z - 2.5));
        life.state.clock = 3.0 * DAY;
        assert_eq!(tax_due(&life, &h), (350.0, 4.0 * DAY));
        toasts(&mut life);
        assert!(pay_tax(&mut life, h.id));
        assert_eq!((life.state.coins, life.state.houses[0].tax_paid_until), (50.0, 14.0 * DAY));
        assert_eq!(toasts(&mut life), ["Paid a week's property tax: 3s 50c"]);
        assert!(!pay_tax(&mut life, h.id));
        assert_eq!(toasts(&mut life), ["Not enough coin to pay the property tax"]);
        // Paying after it lapsed starts the week from now.
        life.state.coins = 350.0;
        life.state.clock = 20.0 * DAY;
        assert!(pay_tax(&mut life, h.id));
        assert_eq!(life.state.houses[0].tax_paid_until, 27.0 * DAY);
        assert!(!pay_tax(&mut life, 999));
    }
}
