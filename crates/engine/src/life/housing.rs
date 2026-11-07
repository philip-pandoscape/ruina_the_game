//! Houses on the plots at Hearthside Rise (the page reads them through src/engine/life/housing.ts).
//!
//! A blueprint claims an empty plot; then the house goes up a stage at a time as you haul each
//! stage's material packs to the site - on your back or by cart - and put in the labor. Finished,
//! it is yours: a bed that restores labor faster, a chest, and a tax bill to keep paid.
//!
//! Plots are the world's, one claim each, first come: the region's registry (the database, online)
//! holds who has each, so a plot is claimed once whichever channel you're in. Land is contested: a
//! house whose tax goes unpaid too long comes down, chest and all, and its plot is free for anyone
//! (housing.json's `neglect`). Taxes run on the land's clock (crate::life::land::now), the world's,
//! so they fall due while you're away.

use std::collections::BTreeMap;

use super::content::{Spot, StageDef, blueprint_def, format_coins, has_blueprint, item_def, items, neglect, pack_def, structure_def};
use super::land::{self, Change, House, Land};
use super::trade::{carried, consume_carried};
use super::{Life, LifeEvent, QuestEvent};
use crate::jsmath::js_max;
use crate::open::zone::{HousePlot, rect, to_world};
use crate::open::{OpenWorld, Sim};

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

/// The house plot `plot`, wherever in the world it is.
pub fn plot_def(plot: &str) -> Option<&'static HousePlot> {
    crate::open::map::world_map().recipes().flat_map(|r| &r.house_plots).find(|p| p.id == plot)
}

/// Index of the house on this plot in life.land.houses, if any.
pub fn house_on(life: &Life, plot: &str) -> Option<usize> {
    life.land.houses.iter().position(|h| h.plot == plot)
}

/// Index of the house with this id in life.land.houses.
fn house_index(life: &Life, id: i64) -> Option<usize> {
    life.land.houses.iter().position(|h| h.id == id)
}

/// The stage a house is on (None once it is finished).
fn stage_of(stages: &'static [StageDef], stage: i64) -> Option<&'static StageDef> {
    usize::try_from(stage).ok().and_then(|s| stages.get(s))
}

/// The house's own position and facing in the world: (x, z, rot).
pub fn house_pose(h: &House) -> (f64, f64, f64) {
    // A house only ever stands on one of the zone's plots; one on a plot that has since gone stands
    // at the origin.
    let (px, pz, rot) = plot_def(&h.plot).map_or((0.0, 0.0, 0.0), |p| (p.x, p.z, p.rot));
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

pub fn place_house(life: &mut Life, _sim: &mut Sim, plot: &str, item: &str) -> bool {
    // Only the zone's plots can be built on.
    if plot_def(plot).is_none() {
        return false;
    }
    if house_on(life, plot).is_some() {
        return false;
    }
    if let Some(owner) = life.plot_owners.get(plot).filter(|o| !o.is_empty()).cloned() {
        life.toast(format!("That plot is {owner}'s"), "bad");
        return false;
    }
    if !life.land.houses.is_empty() {
        life.toast("One house per settler on Emberholm (for now)", "bad");
        return false;
    }
    // The blueprint the item places (its `places`), if there is one.
    let bp_id = item_def(item).places.as_deref().unwrap_or_default();
    if !has_blueprint(bp_id) {
        return false;
    }
    let bp = blueprint_def(bp_id);
    let Some(id) = life.land.new_id() else {
        life.toast("The Land Registry is busy - try again in a moment", "bad");
        return false;
    };
    if !life.take(item, 1) {
        return false;
    }
    let tax_paid_until = land::now(life) + bp.grace_days * DAY;
    life.land.houses.push(House {
        id,
        plot: plot.to_string(),
        blueprint: bp.id.clone(),
        stage: 0,
        delivered: BTreeMap::new(),
        storage: Vec::new(),
        tax_paid_until,
        pending: life.claims_wait,
    });
    // Its ground is cleared once the step is over (Life::make_solid), as the land's shape changed;
    // the registry hears of the claim (online it may yet find the plot someone else's: lose_claim).
    life.revision += 1;
    life.change(Change::Claimed { plot: plot.to_string(), house: id });
    let first = bp.stages.first().map(|s| s.name.to_lowercase()).unwrap_or_default();
    life.toast(format!("📜 Plot claimed! Haul the {first} materials here to begin."), "quest");
    life.notify(QuestEvent::new("placeHouse"));
    true
}

/// The registry has the claim on `plot`: the house on it is yours to build.
pub fn confirm_claim(life: &mut Life, plot: &str) {
    if let Some(i) = house_on(life, plot)
        && life.land.houses[i].pending
    {
        life.land.houses[i].pending = false;
        life.revision += 1;
    }
}

/// Someone else's claim on `plot` reached the registry first (`holder`): the house just put on it
/// comes down again (nothing was built on it while it waited), and the item that claimed it is back
/// in the bag. True if there was one to take down.
pub fn lose_claim(life: &mut Life, plot: &str, holder: &str) -> bool {
    let Some(i) = house_on(life, plot) else { return false };
    let h = life.land.houses.remove(i);
    let deed = items().iter().find(|it| it.places.as_deref() == Some(h.blueprint.as_str()) && it.place_on.as_deref() == Some("plot"));
    if let Some(deed) = deed {
        life.give(&deed.id, 1, true);
    }
    life.plot_owners.insert(plot.to_string(), holder.to_string());
    life.revision += 1;
    life.toast(format!("That plot is {holder}'s: they claimed it first. Your blueprint is back in your bag."), "bad");
    true
}

/// Waiting for the registry to confirm the plot's claim: nothing is built until it has.
fn waiting(life: &mut Life, hi: usize) -> bool {
    if !life.land.houses[hi].pending {
        return false;
    }
    life.toast("The Land Registry hasn't confirmed your claim yet - a moment", "info");
    true
}

/// Hands the pack on your back to the house with this id, if its stage wants it.
pub fn deliver_material(life: &mut Life, sim: &mut Sim, house: i64) -> bool {
    let Some(hi) = house_index(life, house) else { return false };
    if waiting(life, hi) {
        return false;
    }
    let Some(pi) = carried(life, sim) else { return false };
    let pack = life.land.packs[pi].def.clone();
    let h = &life.land.houses[hi];
    let Some(want) = still_needs(h).into_iter().find(|n| n.pack == pack && n.have < n.need) else {
        let what = stage_of(&blueprint_def(&h.blueprint).stages, h.stage).map_or_else(|| "house".to_string(), |s| s.name.to_lowercase());
        life.toast(format!("The {what} does not need a {}", pack_def(&pack).name), "bad");
        return false;
    };
    life.land.houses[hi].delivered.insert(pack.clone(), want.have + 1);
    consume_carried(life, sim);
    life.revision += 1;
    let def = pack_def(&pack);
    life.toast(format!("Delivered {} {} ({}/{})", def.icon, def.name, want.have + 1, want.need), "good");
    true
}

pub fn build_stage(life: &mut Life, _sim: &mut Sim, house: i64) -> bool {
    let Some(hi) = house_index(life, house) else { return false };
    if waiting(life, hi) {
        return false;
    }
    let h = &life.land.houses[hi];
    let bp = blueprint_def(&h.blueprint);
    let Some(stage) = stage_of(&bp.stages, h.stage) else { return false };
    if !stage_ready(h) {
        return false;
    }
    if !life.afford(0.0, 0.0, stage.labor, &format!("build the {}", stage.name.to_lowercase())) {
        return false;
    }
    let h = &mut life.land.houses[hi];
    h.stage += 1;
    h.delivered = BTreeMap::new();
    life.state.stats.built += 1.0;
    // What the stage made solid is, once the step is over (Life::make_solid).
    life.revision += 1;
    let h = &life.land.houses[hi];
    let (x, z, _) = house_pose(h);
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
/// `world.added` under the owner's id (`owner`) as well as the house's. A step that builds leaves
/// this until it's over (`Life::make_solid`).
pub fn add_house_colliders(world: &mut OpenWorld, owner: i64, h: &House) {
    let hf = world.terrain();
    let def = structure_def(&blueprint_def(&h.blueprint).structure);
    let (px, pz, rot) = house_pose(h);
    let y = hf.height(px, pz);
    let key = |what: &str| format!("{owner}:{}:{what}", h.id);
    if world.added.insert(key("ground")) {
        // Keep the footprint (and a metre round it) clear of trees and scarecrows.
        let grid = world.grid();
        let clear = &mut world.clear;
        let mut a = -def.w / 2.0 - 1.0;
        while a <= def.w / 2.0 + 1.0 {
            let mut b = -def.d / 2.0 - 1.0;
            while b <= def.d / 2.0 + 1.0 {
                let (ox, oz) = to_world(a, b, rot);
                let (i, j) = grid.cell_of(px + ox, pz + oz);
                if i >= 0.0
                    && j >= 0.0
                    && i < grid.cells as f64
                    && j < grid.cells as f64
                    && let Some(c) = clear.get_mut(j as usize * grid.cells + i as usize)
                {
                    *c = 1;
                }
                b += grid.cell / 2.0;
            }
            a += grid.cell / 2.0;
        }
    }
    if h.stage >= 1 && world.added.insert(key("floor")) {
        world.index.add_deck(rect(px, pz, def.w / 2.0, def.d / 2.0, rot, y + def.floor.unwrap_or(0.25)));
    }
    if h.stage >= 3 && world.added.insert(key("walls")) {
        let t = def.wall.unwrap_or(0.3);
        let hw = def.w / 2.0;
        let hd = def.d / 2.0;
        let door = def.door.unwrap_or(1.4) / 2.0;
        let top = y + def.h;
        let index = &mut world.index;
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
pub fn interior_point(h: &House, what: &str) -> (f64, f64) {
    let def = structure_def(&blueprint_def(&h.blueprint).structure);
    let p = def.interior.as_ref().and_then(|spots| spots.get(what)).copied().unwrap_or(Spot { x: 0.0, z: 0.0 });
    let (x, z, rot) = house_pose(h);
    let (ox, oz) = to_world(p.x, p.z, rot);
    (x + ox, z + oz)
}

/// (owed, due_in): a week's tax, and how long until what's paid runs out (negative once it has).
pub fn tax_due(life: &Life, h: &House) -> (f64, f64) {
    let bp = blueprint_def(&h.blueprint);
    let due_in = h.tax_paid_until - land::now(life);
    (bp.tax_per_day * 7.0, due_in)
}

/// When a house's tax has gone unpaid so long that it comes down (housing.json's `neglect`), on the
/// land's clock.
pub fn demolished_at(h: &House) -> f64 {
    h.tax_paid_until + neglect().demolish_after_days * DAY
}

/// Whether a house's tax has gone unpaid too long, at `now` on the land's clock. A house whose claim
/// the registry hasn't confirmed yet is never neglected.
pub fn neglected(h: &House, now: f64) -> bool {
    !h.pending && now >= demolished_at(h)
}

/// Takes down every house of `land` whose tax has gone unpaid too long, at `now` on the land's
/// clock: the house, its chest and what's in it. Its plot is free for anyone. Returns the houses
/// taken down. Whoever keeps the land does it: the owner's own life while they play
/// (`step_housing`), the region's keeper of land while they're away.
pub fn demolish_neglected(land: &mut Land, now: f64) -> Vec<House> {
    let (gone, kept): (Vec<House>, Vec<House>) = std::mem::take(&mut land.houses).into_iter().partition(|h| neglected(h, now));
    land.houses = kept;
    gone
}

pub fn pay_tax(life: &mut Life, house: i64) -> bool {
    let Some(hi) = house_index(life, house) else { return false };
    let bp = blueprint_def(&life.land.houses[hi].blueprint);
    let week = bp.tax_per_day * 7.0;
    if !life.afford(week, 0.0, 0.0, "pay the property tax") {
        return false;
    }
    let clock = land::now(life);
    let h = &mut life.land.houses[hi];
    h.tax_paid_until = js_max(h.tax_paid_until, clock) + 7.0 * DAY;
    life.toast(format!("Paid a week's property tax: {}", format_coins(week)), "coin");
    true
}

/// Once a step: a house of yours whose tax went unpaid too long comes down (while you're away, the
/// region's keeper of land does the same: `demolish_neglected`).
pub fn step_housing(life: &mut Life) {
    let now = land::now(life);
    if !life.land.houses.iter().any(|h| neglected(h, now)) {
        return;
    }
    for h in demolish_neglected(&mut life.land, now) {
        life.revision += 1;
        life.change(Change::Freed { plot: h.plot.clone() });
        let name = blueprint_def(&h.blueprint).name.to_lowercase();
        life.toast(format!("Your {name} was taken down: its tax went unpaid too long, and the plot is free for anyone"), "bad");
    }
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

    /// A Sim of its own for one thing a step does, as a statement's temporary.
    macro_rules! sim {
        ($p:expr, $world:expr, $owner:expr) => {
            &mut Sim { player: &mut $p, world: &$world, owner: $owner }
        };
    }

    #[test]
    fn a_house_goes_up_stage_by_stage_and_is_made_solid_once() {
        let (mut life, mut world, mut p) = island(1000.0);
        let (decks, boxes) = (world.index.decks.len(), world.index.boxes.len());
        life.plot_owners.insert("rise-2".into(), "Brann".into());
        life.give("blueprint.cottage", 1, true);
        toasts(&mut life);
        assert!(!place_house(&mut life, sim!(p, world, 7), "rise-2", "blueprint.cottage"));
        assert_eq!(toasts(&mut life), ["That plot is Brann's"]);
        assert!(!place_house(&mut life, sim!(p, world, 7), "nowhere", "blueprint.cottage"));
        assert!(!place_house(&mut life, sim!(p, world, 7), "rise-1", "blueprint.villa"));
        assert!(place_house(&mut life, sim!(p, world, 7), "rise-1", "blueprint.cottage"));
        let h = life.land.houses[0].clone();
        assert_eq!((h.plot.as_str(), h.blueprint.as_str(), h.stage, h.tax_paid_until), ("rise-1", "cottage", 0, 7.0 * DAY));
        assert_eq!(life.count("blueprint.cottage"), 0);
        assert_eq!(toasts(&mut life), ["📜 Plot claimed! Haul the foundation materials here to begin."]);
        // The world is the same for everyone while they step: nothing changes in it until the step
        // that claimed the plot is over. Then the ground is cleared, and nothing is solid yet.
        let grid = world.grid();
        let (x, z, _) = house_pose(&h);
        let (i, j) = grid.cell_of(x, z);
        let cell = j as usize * grid.cells + i as usize;
        assert!(!world.added.contains(&format!("7:{}:ground", h.id)));
        life.make_solid(&mut world, 7);
        assert_eq!(world.clear[cell], 1);
        assert!(world.added.contains(&format!("7:{}:ground", h.id)));
        assert_eq!((world.index.decks.len(), world.index.boxes.len()), (decks, boxes));
        // One each, and none on a plot that's built on.
        life.give("blueprint.cottage", 1, true);
        toasts(&mut life);
        assert!(!place_house(&mut life, sim!(p, world, 7), "rise-3", "blueprint.cottage"));
        assert_eq!(toasts(&mut life), ["One house per settler on Emberholm (for now)"]);
        assert!(!place_house(&mut life, sim!(p, world, 7), "rise-1", "blueprint.cottage"));
        assert_eq!(life.count("blueprint.cottage"), 1);
        // The foundation wants stone, not lumber; the pack you offered stays on your back.
        assert!(!haul(&mut life, sim!(p, world, 7), h.id, "lumberBundle"));
        assert_eq!(toasts(&mut life), ["The foundation does not need a Lumber Bundle"]);
        assert_ne!(p.pack, 0);
        consume_carried(&mut life, sim!(p, world, 7));
        assert!(!build_stage(&mut life, sim!(p, world, 7), h.id), "nothing delivered yet");
        assert!(haul(&mut life, sim!(p, world, 7), h.id, "stoneBlock"));
        assert_eq!(toasts(&mut life), ["Delivered 🧱 Stone Block (1/2)"]);
        assert_eq!(still_needs(&life.land.houses[0]), [Need { pack: "stoneBlock".into(), need: 2, have: 1 }]);
        assert!(haul(&mut life, sim!(p, world, 7), h.id, "stoneBlock"));
        assert!(stage_ready(&life.land.houses[0]));
        assert!(!haul(&mut life, sim!(p, world, 7), h.id, "stoneBlock"), "it has all it needs");
        consume_carried(&mut life, sim!(p, world, 7));
        toasts(&mut life);
        // The foundation: labor spent, and once the step is over a floor to stand on.
        assert!(build_stage(&mut life, sim!(p, world, 7), h.id));
        let built = &life.land.houses[0];
        assert_eq!((built.stage, built.delivered.len(), life.state.labor, life.state.stats.built), (1, 0, 780.0, 1.0));
        assert_eq!(world.index.decks.len(), decks);
        life.make_solid(&mut world, 7);
        assert_eq!((world.index.decks.len(), world.index.boxes.len()), (decks + 1, boxes));
        let floor = world.index.decks[decks];
        let def = structure_def("cottage");
        assert_eq!((floor.x, floor.z, floor.hw, floor.hd), (x, z, def.w / 2.0, def.d / 2.0));
        assert_eq!(floor.top, world.terrain().height(x, z) + def.floor.unwrap());
        let events = life.drain_events();
        assert!(events.contains(&LifeEvent::Build { house: h.id, stage: 1, x, z }));
        assert!(events.contains(&LifeEvent::Toast { text: "🔨 Foundation done. Next: Frame.".into(), kind: "good".into() }));
        // Asking again adds nothing.
        add_house_colliders(&mut world, 7, &life.land.houses[0].clone());
        life.make_solid(&mut world, 7);
        assert_eq!(world.index.decks.len(), decks + 1);
        // Frame, walls (and their five pieces), roof.
        for pack in ["lumberBundle", "lumberBundle"] {
            assert!(haul(&mut life, sim!(p, world, 7), h.id, pack));
        }
        assert!(build_stage(&mut life, sim!(p, world, 7), h.id));
        life.make_solid(&mut world, 7);
        assert_eq!(world.index.boxes.len(), boxes);
        for pack in ["lumberBundle", "stoneBlock", "lumberBundle"] {
            assert!(haul(&mut life, sim!(p, world, 7), h.id, pack));
        }
        assert!(build_stage(&mut life, sim!(p, world, 7), h.id));
        life.make_solid(&mut world, 7);
        assert_eq!(world.index.boxes.len(), boxes + 5);
        let ground = world.terrain().height(x, z);
        assert!(world.index.boxes[boxes..].iter().all(|b| b.top == ground + def.h));
        for pack in ["ironCrate", "lumberBundle"] {
            assert!(haul(&mut life, sim!(p, world, 7), h.id, pack));
        }
        toasts(&mut life);
        assert!(build_stage(&mut life, sim!(p, world, 7), h.id));
        life.make_solid(&mut world, 7);
        assert!(is_complete(&life.land.houses[0]));
        assert_eq!(toasts(&mut life), ["🏡 Your cottage is finished. Welcome home."]);
        assert_eq!((life.state.labor, life.state.stats.built), (700.0, 4.0));
        assert_eq!((world.index.decks.len(), world.index.boxes.len()), (decks + 1, boxes + 5));
        assert!(!build_stage(&mut life, sim!(p, world, 7), h.id), "nothing left to build");
        assert!(still_needs(&life.land.houses[0]).is_empty());
        assert!(!haul(&mut life, sim!(p, world, 7), h.id, "stoneBlock"));
        assert_eq!(toasts(&mut life), ["The house does not need a Stone Block"]);
        assert!(!build_stage(&mut life, sim!(p, world, 7), 999));
    }

    #[test]
    fn another_settlers_house_with_the_same_id_is_solid_too() {
        let (mut mine, mut world, mut p) = island(0.0);
        let (mut theirs, _, mut q) = island(0.0);
        let (decks, boxes) = (world.index.decks.len(), world.index.boxes.len());
        mine.give("blueprint.cottage", 1, true);
        theirs.give("blueprint.cottage", 1, true);
        assert!(place_house(&mut mine, sim!(p, world, 1), "rise-1", "blueprint.cottage"));
        assert!(place_house(&mut theirs, sim!(q, world, 2), "rise-5", "blueprint.cottage"));
        assert_eq!(mine.land.houses[0].id, theirs.land.houses[0].id);
        mine.land.houses[0].stage = 3;
        theirs.land.houses[0].stage = 3;
        mine.make_solid(&mut world, 1);
        theirs.make_solid(&mut world, 2);
        theirs.make_solid(&mut world, 2);
        assert_eq!((world.index.decks.len(), world.index.boxes.len()), (decks + 2, boxes + 10));
    }

    #[test]
    fn the_bed_and_chest_stand_where_the_structure_puts_them_and_tax_is_paid_by_the_week() {
        let (mut life, mut world, mut p) = island(400.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        life.give("blueprint.cottage", 1, true);
        assert!(place_house(&mut life, &mut sim, "rise-5", "blueprint.cottage"));
        let h = life.land.houses[0].clone();
        // rise-5 faces +Z (rot 0): local points are world offsets from the house.
        let plot = plot_def("rise-5").unwrap();
        assert_eq!(house_pose(&h), (plot.x, plot.z - 2.5, 0.0));
        let bed = structure_def("cottage").interior.as_ref().unwrap()["bed"];
        assert_eq!(interior_point(&h, "bed"), (plot.x + bed.x, plot.z - 2.5 + bed.z));
        assert_eq!(interior_point(&h, "nowhere"), (plot.x, plot.z - 2.5));
        life.state.clock = 3.0 * DAY;
        assert_eq!(tax_due(&life, &h), (350.0, 4.0 * DAY));
        toasts(&mut life);
        assert!(pay_tax(&mut life, h.id));
        assert_eq!((life.state.coins, life.land.houses[0].tax_paid_until), (50.0, 14.0 * DAY));
        assert_eq!(toasts(&mut life), ["Paid a week's property tax: 3s 50c"]);
        assert!(!pay_tax(&mut life, h.id));
        assert_eq!(toasts(&mut life), ["Not enough coin to pay the property tax"]);
        // Paying after it lapsed starts the week from now.
        life.state.coins = 350.0;
        life.state.clock = 20.0 * DAY;
        assert!(pay_tax(&mut life, h.id));
        assert_eq!(life.land.houses[0].tax_paid_until, 27.0 * DAY);
        assert!(!pay_tax(&mut life, 999));
    }

    #[test]
    fn online_a_claim_waits_for_the_registry_and_one_that_lost_the_race_comes_down_again() {
        let (mut life, world, mut p) = island(0.0);
        life.claims_wait = true;
        life.give("blueprint.cottage", 1, true);
        assert!(place_house(&mut life, sim!(p, world, 7), "rise-2", "blueprint.cottage"));
        let id = life.land.houses[0].id;
        assert!(life.land.houses[0].pending);
        assert_eq!(life.take_changes(), [Change::Claimed { plot: "rise-2".into(), house: id }]);
        // Nothing is built on it until the registry has the claim.
        toasts(&mut life);
        assert!(!haul(&mut life, sim!(p, world, 7), id, "stoneBlock"));
        assert!(!build_stage(&mut life, sim!(p, world, 7), id));
        assert_eq!(toasts(&mut life).last().map(String::as_str), Some("The Land Registry hasn't confirmed your claim yet - a moment"));
        consume_carried(&mut life, sim!(p, world, 7));
        // Someone in another channel claimed it first: the house goes, the blueprint comes back.
        assert!(lose_claim(&mut life, "rise-2", "Brann"));
        assert!(life.land.houses.is_empty());
        assert_eq!(life.count("blueprint.cottage"), 1);
        assert_eq!(life.plot_owners.get("rise-2").map(String::as_str), Some("Brann"));
        assert_eq!(toasts(&mut life), ["That plot is Brann's: they claimed it first. Your blueprint is back in your bag."]);
        // Another plot, and this time the registry has it.
        assert!(place_house(&mut life, sim!(p, world, 7), "rise-3", "blueprint.cottage"));
        confirm_claim(&mut life, "rise-3");
        assert!(!life.land.houses[0].pending);
        let id = life.land.houses[0].id;
        assert!(haul(&mut life, sim!(p, world, 7), id, "stoneBlock"));
        assert!(!lose_claim(&mut life, "rise-9", "Nobody"), "nothing on that plot");
    }

    #[test]
    fn tax_runs_on_the_worlds_clock_and_a_neglected_house_comes_down() {
        let (mut life, world, mut p) = island(1000.0);
        // Online the land's clock is the world's: a long way from the life's own.
        let t0 = 1.76e9;
        life.world_clock = Some(t0);
        life.give("blueprint.cottage", 1, true);
        assert!(place_house(&mut life, sim!(p, world, 7), "rise-4", "blueprint.cottage"));
        let grace = blueprint_def("cottage").grace_days * DAY;
        assert_eq!(life.land.houses[0].tax_paid_until, t0 + grace);
        let h = life.land.houses[0].clone();
        assert_eq!(tax_due(&life, &h).1, grace);
        let gone_at = demolished_at(&h);
        assert_eq!(gone_at, t0 + grace + neglect().demolish_after_days * DAY);
        life.take_changes();
        toasts(&mut life);
        // Overdue, but not yet long enough: it stands.
        life.world_clock = Some(gone_at - 1.0);
        assert!(!neglected(&h, gone_at - 1.0));
        step_housing(&mut life);
        assert_eq!(life.land.houses.len(), 1);
        assert!(tax_due(&life, &life.land.houses[0].clone()).1 < 0.0);
        // Paying then counts from now: the week starts today.
        let mut paid = life.land.houses[0].clone();
        paid.tax_paid_until = gone_at - 1.0 + 7.0 * DAY;
        assert!(!neglected(&paid, gone_at));
        // Left that long, it comes down, chest and all, and its plot is free for anyone.
        life.land.houses[0].storage.push(crate::life::state::Stack { item: "stone".into(), n: 5 });
        life.world_clock = Some(gone_at);
        let rev = life.revision;
        step_housing(&mut life);
        assert!(life.land.houses.is_empty() && life.revision > rev);
        assert_eq!(life.take_changes(), [Change::Freed { plot: "rise-4".into() }]);
        assert_eq!(toasts(&mut life), ["Your cottage was taken down: its tax went unpaid too long, and the plot is free for anyone"]);
        assert_eq!(life.count("stone"), 0, "what was in its chest went with it");
        // The keeper of land does the same to an owner who is away; a claim still waiting never is.
        let mut away = Land { houses: vec![h.clone(), House { id: 9, pending: true, ..h.clone() }], ..Land::default() };
        assert_eq!(demolish_neglected(&mut away, gone_at).iter().map(|x| x.id).collect::<Vec<_>>(), [h.id]);
        assert_eq!(away.houses.iter().map(|x| x.id).collect::<Vec<_>>(), [9]);
    }
}
