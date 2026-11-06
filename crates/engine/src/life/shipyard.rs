//! Ships built on slipways (src/engine/life/shipyard.ts).
//!
//! Big ships are built the way houses are: a design claims the slip, then each stage is finished
//! by hauling its material packs there and putting in the labor. The last stage launches her: the
//! slip clears and you hold the deed.

use std::collections::BTreeMap;

use super::content::{ShipStageDef, design_for_item, item_def, pack_def, ship_design};
use super::housing::Need;
use super::state::ShipBuild;
use super::trade::{carried, consume_carried};
use super::{Life, LifeEvent, QuestEvent};
use crate::open::Sim;
use crate::open::zone::Shipyard;

pub fn slip_def(life: &Life, slip: &str) -> Option<&'static Shipyard> {
    life.zone.recipe.shipyards.iter().find(|s| s.id == slip)
}

/// Index of the ship on this slipway in life.state.ships, if any.
pub fn ship_on(life: &Life, slip: &str) -> Option<usize> {
    life.state.ships.iter().position(|s| s.slip == slip)
}

/// Index of the ship with this id in life.state.ships.
fn ship_index(life: &Life, id: i64) -> Option<usize> {
    life.state.ships.iter().position(|s| s.id == id)
}

/// The stage a ship is on (None once she is finished).
fn stage_of(stages: &'static [ShipStageDef], stage: i64) -> Option<&'static ShipStageDef> {
    usize::try_from(stage).ok().and_then(|s| stages.get(s))
}

pub fn ship_needs(b: &ShipBuild) -> Vec<Need> {
    let Some(stage) = stage_of(&ship_design(&b.design).stages, b.stage) else { return Vec::new() };
    stage.needs.iter().map(|(pack, need)| Need { pack: pack.to_string(), need, have: b.delivered.get(pack).copied().unwrap_or(0) }).collect()
}

pub fn ship_stage_ready(b: &ShipBuild) -> bool {
    ship_needs(b).iter().all(|n| n.have >= n.need)
}

pub fn ship_finished(b: &ShipBuild) -> bool {
    b.stage >= ship_design(&b.design).stages.len() as i64
}

pub fn lay_keel(life: &mut Life, slip: &str, item: &str) -> bool {
    if ship_on(life, slip).is_some() {
        return false;
    }
    let Some(design) = design_for_item(item) else { return false };
    if !life.take(item, 1) {
        return false;
    }
    let id = life.next_id();
    life.state.ships.push(ShipBuild { id, slip: slip.to_string(), design: design.id.clone(), stage: 0, delivered: BTreeMap::new() });
    life.revision += 1;
    let first = design.stages.first().map(|s| s.name.to_lowercase()).unwrap_or_default();
    life.toast(format!("📐 The {}'s keel blocks are down. Haul {first} materials to the slip.", design.name), "quest");
    life.notify(QuestEvent::new("layKeel"));
    true
}

/// Hands the pack on your back to the ship with this id.
pub fn deliver_ship_material(life: &mut Life, sim: &mut Sim, ship: i64) -> bool {
    let Some(si) = ship_index(life, ship) else { return false };
    let Some(pi) = carried(life, sim) else { return false };
    let pack = life.state.packs[pi].def.clone();
    let Some(want) = ship_needs(&life.state.ships[si]).into_iter().find(|n| n.pack == pack && n.have < n.need) else {
        life.toast(format!("This stage does not need a {}", pack_def(&pack).name), "bad");
        return false;
    };
    life.state.ships[si].delivered.insert(pack.clone(), want.have + 1);
    consume_carried(life, sim);
    life.revision += 1;
    let def = pack_def(&pack);
    life.toast(format!("Delivered {} {} ({}/{})", def.icon, def.name, want.have + 1, want.need), "good");
    true
}

pub fn build_ship_stage(life: &mut Life, ship: i64) -> bool {
    let Some(si) = ship_index(life, ship) else { return false };
    let b = &life.state.ships[si];
    let design = ship_design(&b.design);
    let Some(stage) = stage_of(&design.stages, b.stage) else { return false };
    if !ship_stage_ready(b) {
        return false;
    }
    if !life.afford(0.0, 0.0, stage.labor, &format!("build the {}", stage.name.to_lowercase())) {
        return false;
    }
    let b = &mut life.state.ships[si];
    b.stage += 1;
    b.delivered = BTreeMap::new();
    life.revision += 1;
    let b = &life.state.ships[si];
    let (id, now, finished) = (b.id, b.stage, ship_finished(b));
    if let Some(slip) = slip_def(life, &b.slip) {
        life.emit(LifeEvent::Build { house: id, stage: now, x: slip.x, z: slip.z });
    }
    life.notify(QuestEvent::new("shipStage"));
    if finished {
        life.toast(format!("⚓ The {} is finished. Launch her from the slipway!", design.name), "quest");
    } else {
        let next = stage_of(&design.stages, now).map_or("", |s| s.name.as_str());
        life.toast(format!("🔨 {} done. Next: {next}.", stage.name), "good");
    }
    true
}

pub fn launch(life: &mut Life, ship: i64) -> bool {
    let Some(si) = ship_index(life, ship) else { return false };
    if !ship_finished(&life.state.ships[si]) {
        return false;
    }
    let design = ship_design(&life.state.ships[si].design);
    if !life.has_room(&design.deed, 1) {
        life.toast("Make room in your bag for the deed first", "bad");
        return false;
    }
    life.state.ships.retain(|s| s.id != ship);
    life.give(&design.deed, 1, true);
    life.revision += 1;
    life.toast(format!("🚢 The {} is launched! Her deed is in your bag - summon her at deep water.", design.name), "quest");
    life.notify(QuestEvent::new("launch"));
    true
}

pub fn design_items_in_bag(life: &Life) -> Vec<String> {
    life.state.bag.iter().map(|s| s.item.clone()).filter(|i| design_for_item(i).is_some() && item_def(i).cat == "placeable").collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::content::ship_designs;
    use crate::life::trade::make_pack;
    use crate::life::trade::testing::{island, toasts};

    const SLIP: &str = "lanternwick-slip";

    #[test]
    fn a_ship_is_built_on_the_slip_and_launched() {
        let (mut life, mut world, mut p) = island(0.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        // Only a design lays a keel, and only one you have.
        life.give("lumber", 5, true);
        assert!(!lay_keel(&mut life, SLIP, "lumber"));
        assert!(!lay_keel(&mut life, SLIP, "design.cog"));
        assert!(design_items_in_bag(&life).is_empty());
        life.give("design.cog", 1, true);
        assert_eq!(design_items_in_bag(&life), ["design.cog"]);
        toasts(&mut life);
        assert!(lay_keel(&mut life, SLIP, "design.cog"));
        assert_eq!(toasts(&mut life), ["📐 The Merchant Cog's keel blocks are down. Haul keel materials to the slip."]);
        assert_eq!(life.count("design.cog"), 0);
        let ship = life.state.ships[ship_on(&life, SLIP).unwrap()].id;
        life.give("design.cog", 1, true);
        assert!(!lay_keel(&mut life, SLIP, "design.cog"), "the slip is taken");
        // Something the keel doesn't want stays on your back.
        sim.player.pack = make_pack(&mut life, "sailcloth", "lanternwick");
        assert!(!deliver_ship_material(&mut life, &mut sim, ship));
        assert_eq!(toasts(&mut life), ["This stage does not need a Sailcloth Bundle"]);
        consume_carried(&mut life, &mut sim);
        assert!(!build_ship_stage(&mut life, ship), "nothing delivered yet");
        assert!(!launch(&mut life, ship), "not built yet");
        // Each stage: haul its packs, put in the labor.
        let design = ship_design("cog");
        for (k, stage) in design.stages.iter().enumerate() {
            for (pack, n) in stage.needs.iter() {
                for got in 1..=n {
                    sim.player.pack = make_pack(&mut life, pack, "x");
                    assert!(deliver_ship_material(&mut life, &mut sim, ship));
                    let def = pack_def(pack);
                    assert_eq!(toasts(&mut life), [format!("Delivered {} {} ({got}/{n})", def.icon, def.name)]);
                }
            }
            assert!(ship_stage_ready(&life.state.ships[0]));
            assert!(build_ship_stage(&mut life, ship));
            assert_eq!(life.state.ships[0].stage, k as i64 + 1);
            assert!(life.state.ships[0].delivered.is_empty());
            let events = life.drain_events();
            assert!(events.contains(&LifeEvent::Build { house: ship, stage: k as i64 + 1, x: 48.0, z: -341.0 }));
            let said: Vec<&LifeEvent> = events.iter().filter(|e| matches!(e, LifeEvent::Toast { .. })).collect();
            let want = match design.stages.get(k + 1) {
                Some(next) => format!("🔨 {} done. Next: {}.", stage.name, next.name),
                None => "⚓ The Merchant Cog is finished. Launch her from the slipway!".to_string(),
            };
            assert_eq!(said, [&LifeEvent::Toast { text: want, kind: if k + 1 < design.stages.len() { "good" } else { "quest" }.into() }]);
        }
        assert!(ship_finished(&life.state.ships[0]));
        assert!(ship_needs(&life.state.ships[0]).is_empty());
        assert!(!build_ship_stage(&mut life, ship), "nothing left to build");
        assert_eq!(life.state.labor, 800.0 - 40.0 - 50.0 - 40.0 - 50.0);
        // Launched: the slip is clear and the deed is yours.
        assert!(launch(&mut life, ship));
        assert!(life.state.ships.is_empty() && ship_on(&life, SLIP).is_none());
        assert_eq!(life.count("deed.cog"), 1);
        assert_eq!(toasts(&mut life), ["🚢 The Merchant Cog is launched! Her deed is in your bag - summon her at deep water."]);
        assert!(!launch(&mut life, ship));
    }

    #[test]
    fn the_labor_and_the_room_for_the_deed_come_first() {
        let (mut life, _, _) = island(0.0);
        life.state.ships.push(ShipBuild {
            id: 40,
            slip: SLIP.into(),
            design: "cog".into(),
            stage: 0,
            delivered: BTreeMap::from([("lumberBundle".to_string(), 3)]),
        });
        life.state.labor = 10.0;
        toasts(&mut life);
        assert!(!build_ship_stage(&mut life, 40));
        assert_eq!(toasts(&mut life), ["Too tired - not enough labor to build the keel"]);
        assert_eq!(life.state.ships[0].stage, 0);
        life.state.ships[0].stage = ship_designs()[0].stages.len() as i64;
        for i in 0..crate::life::content::bag_slots() {
            life.state.bag.push(crate::life::state::Stack { item: format!("filler{i}"), n: 1 });
        }
        assert!(!launch(&mut life, 40));
        assert_eq!(toasts(&mut life), ["Make room in your bag for the deed first"]);
        assert_eq!(life.state.ships.len(), 1);
        life.state.bag.pop();
        assert!(launch(&mut life, 40));
        assert_eq!(life.count("deed.cog"), 1);
    }
}
