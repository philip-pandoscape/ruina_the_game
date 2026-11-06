//! Trade packs, workbenches, vendors and trading posts (src/sim/life/trade.ts).
//!
//! Pack running. A pack is made at a workbench from local goods and labor, rides on your back
//! (slowly - no sprint, no double jump, no glider) or in a vehicle's cargo, and is sold at a
//! trading post somewhere else. Farther routes pay more; each sale lowers that post's demand for
//! that pack, which recovers with time; a fresh pack earns a bonus that sours the longer it sits.

use super::content::{self, RecipeDef, format_coins, item_def, pack_def, place_name, recipe, route, vendor_for};
use super::contracts::contract_delivered;
use super::state::{Buyback, Pack};
use super::vehicles::vehicle_index;
use super::{Life, LifeEvent, QuestEvent};
use crate::jsmath::JsMath;
use crate::jsmath::{js_hypot, js_max, js_min, js_round};
use crate::open::Sim;
use crate::open::colliders::ground_at;
use crate::player::Mode;

// ---------- Prices ----------

fn demand_key(outpost: &str, pack: &str) -> String {
    format!("{outpost}:{pack}")
}

pub fn demand_at(life: &Life, outpost: &str, pack: &str) -> f64 {
    life.state.demand.get(&demand_key(outpost, pack)).copied().unwrap_or(content::demand().start)
}

/// Freshness multiplier for a pack of this age (seconds).
pub fn freshness(age: f64) -> f64 {
    let f = content::freshness();
    let top = 1.0 + f.bonus;
    let bottom = 1.0 + f.penalty;
    if age <= f.bonus_seconds {
        return top;
    }
    if age >= f.stale_seconds {
        return bottom;
    }
    let k = (age - f.bonus_seconds) / (f.stale_seconds - f.bonus_seconds);
    top + (bottom - top) * k
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quote {
    pub coins: f64,
    pub seals: f64,
    pub demand: f64,
    pub fresh: f64,
    pub factor: f64,
}

/// What a trading post would pay for a pack right now, or None if it will not buy it.
pub fn quote(life: &Life, pack: &Pack, outpost: &str) -> Option<Quote> {
    let def = pack_def(&pack.def);
    if def.kind.as_deref() == Some("material") {
        return None;
    }
    let r = route(&pack.origin, outpost)?;
    let demand = demand_at(life, outpost, &pack.def);
    let fresh = freshness(life.state.clock - pack.made);
    Some(Quote { coins: js_round(def.base * r.factor * demand * fresh), seals: r.seals, demand, fresh, factor: r.factor })
}

pub fn step_trade(life: &mut Life, dt: f64) {
    let d = content::demand();
    for v in life.state.demand.values_mut() {
        *v = js_min(d.max, *v + (d.recover_per_minute * dt) / 60.0);
    }
}

/// Recovers demand over a long stretch (time away).
pub fn recover_demand(life: &mut Life, seconds: f64) {
    step_trade(life, seconds);
}

// ---------- Where packs are ----------

/// Index of the pack with this id in life.state.packs (TS packById).
pub fn pack_index(life: &Life, id: i64) -> Option<usize> {
    life.state.packs.iter().position(|p| p.id == id)
}

/// Index of the pack on the player's back, if any (TS carried).
pub fn carried(life: &Life, sim: &Sim) -> Option<usize> {
    if sim.player.pack != 0 { pack_index(life, sim.player.pack) } else { None }
}

fn remove_pack(life: &mut Life, id: i64) {
    if let Some(i) = pack_index(life, id) {
        life.state.packs.remove(i);
    }
    life.revision += 1;
}

/// Makes a pack (on the back) and returns its id.
pub fn make_pack(life: &mut Life, def: &str, origin: &str) -> i64 {
    let id = life.next_id();
    let made = life.state.clock;
    life.state.packs.push(Pack {
        id,
        def: def.to_string(),
        made,
        origin: origin.to_string(),
        at: "back".into(),
        x: 0.0,
        y: 0.0,
        z: 0.0,
        rot: 0.0,
        vehicle: 0,
        slot: 0,
    });
    life.revision += 1;
    id
}

// ---------- Crafting ----------

/// Makes a pack at a workbench (place is where that bench is).
pub fn craft_pack(life: &mut Life, sim: &mut Sim, r: &RecipeDef, place: &str) -> bool {
    let def = pack_def(r.makes.pack.as_deref().unwrap_or(""));
    if sim.player.pack != 0 {
        life.toast("Your back is already full - set that pack down first (X)", "bad");
        return false;
    }
    if sim.player.mode != Mode::Normal || !sim.player.grounded {
        life.toast("Stand still at the bench to work", "bad");
        return false;
    }
    for inp in &def.inputs {
        if life.count(&inp.item) < inp.n {
            life.toast(format!("Needs {} {} (you have {})", inp.n, item_def(&inp.item).name, life.count(&inp.item)), "bad");
            return false;
        }
    }
    if !life.afford(def.fee, 0.0, def.labor, &format!("pack a {}", def.name)) {
        return false;
    }
    for inp in &def.inputs {
        life.take(&inp.item, inp.n);
    }
    let pack = make_pack(life, &def.id, place);
    sim.player.pack = pack;
    life.toast(format!("{} {} packed - it's on your back", def.icon, def.name), "good");
    life.notify(QuestEvent { pack: Some(def.id.clone()), ..QuestEvent::new("craftPack") });
    true
}

/// An item recipe: a crafter or a workbench turns materials and coin into something for the bag.
pub fn craft_item(life: &mut Life, r: &RecipeDef) -> bool {
    // The TypeScript would throw on a recipe that makes nothing.
    let Some(item) = r.makes.item.as_deref() else { return false };
    let n = r.makes.n.unwrap_or(1);
    for inp in r.inputs.iter().flatten() {
        if life.count(&inp.item) < inp.n {
            life.toast(format!("Needs {} {} (you have {})", inp.n, item_def(&inp.item).name, life.count(&inp.item)), "bad");
            return false;
        }
    }
    if !life.has_room(item, n) {
        life.toast("Your bag is full", "bad");
        return false;
    }
    if !life.afford(r.coins.unwrap_or(0.0), 0.0, r.labor.unwrap_or(0.0), &format!("make {}", item_def(item).name)) {
        return false;
    }
    life.take_all(r.inputs.as_ref());
    life.give(item, n, false);
    life.notify(QuestEvent { item: Some(item.to_string()), ..QuestEvent::new("craft") });
    true
}

pub fn run_recipe(life: &mut Life, sim: &mut Sim, id: &str) -> bool {
    let Some(r) = recipe(id) else { return false };
    if let Some(pack) = r.makes.pack.as_deref().filter(|p| !p.is_empty()) {
        // Made where its workbench stands; by a crafter, where the pack says it comes from.
        let zone = life.zone;
        let bench = zone.recipe.workbenches.iter().find(|b| b.id == r.bench);
        return craft_pack(life, sim, r, bench.map_or_else(|| pack_def(pack).origin.as_str(), |b| b.place.as_str()));
    }
    craft_item(life, r)
}

// ---------- Carrying ----------

pub fn drop_pack(life: &mut Life, sim: &mut Sim) -> bool {
    let Some(i) = carried(life, sim) else { return false };
    let p = &*sim.player;
    if p.mode == Mode::Ride || p.mode == Mode::Swim {
        life.toast("You cannot set a pack down here", "bad");
        return false;
    }
    let hf = sim.terrain();
    let x = p.pos.x + p.facing.js_sin() * 0.9;
    let z = p.pos.z + p.facing.js_cos() * 0.9;
    let y = ground_at(hf, &sim.world.index, x, z, p.pos.y + 0.3, 0.6);
    let rot = p.facing;
    let pack = &mut life.state.packs[i];
    pack.at = "ground".into();
    pack.x = x;
    pack.z = z;
    pack.y = y;
    pack.rot = rot;
    sim.player.pack = 0;
    life.revision += 1;
    true
}

/// Picks up the pack with this id.
pub fn pick_up(life: &mut Life, sim: &mut Sim, pack: i64) -> bool {
    // The TypeScript's caller looks the pack up first and does nothing if it is gone.
    let Some(i) = pack_index(life, pack) else { return false };
    if sim.player.pack != 0 {
        life.toast("You are already carrying a pack", "bad");
        return false;
    }
    if sim.player.mode == Mode::Glide {
        return false;
    }
    let pk = &mut life.state.packs[i];
    pk.at = "back".into();
    pk.vehicle = 0;
    sim.player.pack = pk.id;
    life.revision += 1;
    true
}

/// Loads the pack on your back into the vehicle's cargo slot.
pub fn load_pack(life: &mut Life, sim: &mut Sim, vehicle: i64, slot: usize) -> bool {
    let Some(v) = vehicle_index(life, vehicle) else { return false };
    let Some(i) = carried(life, sim) else { return false };
    // A slot that is taken, or that the vehicle doesn't have.
    if life.state.vehicles[v].cargo.get(slot) != Some(&0) {
        return false;
    }
    let vid = life.state.vehicles[v].id;
    let pk = &mut life.state.packs[i];
    pk.at = "cargo".into();
    pk.vehicle = vid;
    pk.slot = slot as i64;
    let id = pk.id;
    life.state.vehicles[v].cargo[slot] = id;
    sim.player.pack = 0;
    life.revision += 1;
    life.notify(QuestEvent::new("load"));
    true
}

/// Takes the pack in the vehicle's cargo slot onto your back.
pub fn unload_pack(life: &mut Life, sim: &mut Sim, vehicle: i64, slot: usize) -> bool {
    let Some(v) = vehicle_index(life, vehicle) else { return false };
    if sim.player.pack != 0 {
        life.toast("Your back is already full", "bad");
        return false;
    }
    let id = life.state.vehicles[v].cargo.get(slot).copied().unwrap_or(0);
    let Some(i) = (if id != 0 { pack_index(life, id) } else { None }) else { return false };
    life.state.vehicles[v].cargo[slot] = 0;
    let pk = &mut life.state.packs[i];
    pk.at = "back".into();
    pk.vehicle = 0;
    sim.player.pack = pk.id;
    life.revision += 1;
    true
}

// ---------- Selling ----------

/// " + 3 seals" after a price, or nothing when there are none.
fn plus_seals(seals: f64) -> String {
    if seals != 0.0 && !seals.is_nan() { format!(" + {seals} seal{}", if seals > 1.0 { "s" } else { "" }) } else { String::new() }
}

pub fn sell_pack(life: &mut Life, sim: &mut Sim, outpost: &str) -> bool {
    let Some(i) = carried(life, sim) else { return false };
    let pack = life.state.packs[i].clone();
    let q = quote(life, &pack, outpost);
    let def = pack_def(&pack.def);
    let Some(q) = q else {
        let why = if pack.origin == outpost {
            format!("{} makes these itself - sell it somewhere else", place_name(outpost))
        } else {
            format!("{} does not buy {}", place_name(outpost), def.name)
        };
        life.toast(why, "bad");
        return false;
    };
    let s = &mut life.state;
    s.coins += q.coins;
    s.seals += q.seals;
    s.stats.delivered += 1.0;
    s.stats.earned += q.coins;
    let d = content::demand();
    let lowered = js_max(d.min, demand_at(life, outpost, &pack.def) - d.drop_per_sale);
    life.state.demand.insert(demand_key(outpost, &pack.def), lowered);
    sim.player.pack = 0;
    remove_pack(life, pack.id);
    life.emit(LifeEvent::Sold { pack: def.id.clone(), coins: q.coins, seals: q.seals, demand: q.demand, fresh: q.fresh, outpost: outpost.to_string() });
    life.toast(format!("Sold {}: {}{}", def.name, format_coins(q.coins), plus_seals(q.seals)), "coin");
    life.notify(QuestEvent { outpost: Some(outpost.to_string()), pack: Some(def.id.clone()), ..QuestEvent::new("deliver") });
    contract_delivered(life, outpost, &def.id);
    true
}

/// A material pack is used up by a building site.
pub fn consume_carried(life: &mut Life, sim: &mut Sim) {
    let Some(i) = carried(life, sim) else { return };
    let id = life.state.packs[i].id;
    sim.player.pack = 0;
    remove_pack(life, id);
}

// ---------- Shops ----------

pub fn buy(life: &mut Life, npc: &str, item: &str, n: i64) -> bool {
    let v = vendor_for(npc);
    let offer = v.and_then(|v| v.sells.iter().find(|s| s.item == item));
    let Some(offer) = offer else { return false };
    if n <= 0 {
        return false;
    }
    if !life.has_room(item, n) {
        life.toast("Your bag is full", "bad");
        return false;
    }
    let def = item_def(item);
    if !life.afford(offer.price * n as f64, offer.seals.unwrap_or(0.0) * n as f64, 0.0, &format!("buy {}", def.name)) {
        return false;
    }
    life.give(item, n, false);
    life.notify(QuestEvent { item: Some(item.to_string()), ..QuestEvent::new("buy") });
    true
}

pub fn sell(life: &mut Life, npc: &str, item: &str, n: i64) -> bool {
    let Some(v) = vendor_for(npc) else { return false };
    if !v.buys.iter().any(|b| b == item) || n <= 0 {
        return false;
    }
    let have = life.count(item);
    let amount = n.min(have);
    if amount == 0 {
        return false;
    }
    let price = js_max(1.0, js_round(item_def(item).value * v.buy_rate));
    life.take(item, amount);
    life.state.coins += price * amount as f64;
    remember(life, npc, item, amount, price);
    life.toast(format!("Sold {} {} for {}", amount, item_def(item).name, format_coins(price * amount as f64)), "coin");
    life.notify(QuestEvent { item: Some(item.to_string()), ..QuestEvent::new("sell") });
    true
}

// ---------- Buyback ----------
// A merchant holds what you sold them, at what they paid, until you walk off: sell the wrong stack
// and you can have it back, but a stall is no place to keep things.

/// How far from a merchant you can go before they stop holding what you sold them.
pub const BUYBACK_RANGE: f64 = 12.0;
/// Sales held at once, across every merchant; the oldest go first.
const BUYBACK_MAX: usize = 12;

fn remember(life: &mut Life, npc: &str, item: &str, n: i64, price: f64) {
    let list = life.state.buyback.get_or_insert_with(Vec::new);
    if let Some(same) = list.iter_mut().find(|b| b.npc == npc && b.item == item && b.price == price) {
        same.n += n;
    } else {
        list.push(Buyback { npc: npc.to_string(), item: item.to_string(), n, price });
    }
    while list.len() > BUYBACK_MAX {
        list.remove(0);
    }
}

/// Buys back up to n of something you sold this merchant, at what they paid you for it.
pub fn buy_back(life: &mut Life, npc: &str, item: &str, n: i64) -> bool {
    let Some(k) = life.state.buyback.as_ref().and_then(|list| list.iter().position(|b| b.npc == npc && b.item == item)) else { return false };
    if n <= 0 {
        return false;
    }
    let (held, price) = life.state.buyback.as_ref().map_or((0, 0.0), |list| (list[k].n, list[k].price));
    let amount = n.min(held);
    if !life.has_room(item, amount) {
        life.toast("Your bag is full", "bad");
        return false;
    }
    if !life.afford(price * amount as f64, 0.0, 0.0, &format!("buy back {}", item_def(item).name)) {
        return false;
    }
    if let Some(list) = life.state.buyback.as_mut() {
        list[k].n -= amount;
        if list[k].n <= 0 {
            list.remove(k);
        }
    }
    life.give(item, amount, false);
    true
}

/// Walk off from a merchant and they let go of what you sold them.
pub fn step_buyback(life: &mut Life, sim: &Sim) {
    let Some(list) = life.state.buyback.as_ref() else { return };
    if list.is_empty() {
        return;
    }
    let (x, z) = (sim.player.pos.x, sim.player.pos.z);
    let zone = life.zone;
    let kept: Vec<Buyback> =
        list.iter().filter(|b| zone.recipe.npcs.iter().find(|n| n.id == b.npc).is_some_and(|n| js_hypot(n.x - x, n.z - z) <= BUYBACK_RANGE)).cloned().collect();
    if kept.len() != list.len() {
        life.state.buyback = Some(kept);
    }
}

/// A fresh island to try the rules on, shared by the life modules' tests.
#[cfg(test)]
pub(crate) mod testing {
    use crate::life::{Life, LifeEvent};
    use crate::open::OpenWorld;
    use crate::open::zone::emberholm;
    use crate::player::{Build, Player};

    /// A new island (with this much money), its world, and a player standing at the spawn.
    pub fn island(coins: f64) -> (Life, OpenWorld, Player) {
        let zone = emberholm();
        let life = Life::new(zone, Some(coins), None);
        let world = OpenWorld::new(zone);
        let s = zone.recipe.spawn;
        let mut p = Player::new(crate::world::Spawn { x: s.x, z: s.z, facing: s.facing }, 0, Build::default());
        p.pos.y = zone.terrain.height(s.x, s.z);
        (life, world, p)
    }

    /// The toasts since the last look.
    pub fn toasts(life: &mut Life) -> Vec<String> {
        life.drain_events().into_iter().filter_map(|e| if let LifeEvent::Toast { text, .. } = e { Some(text) } else { None }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{island, toasts};
    use super::*;
    use crate::life::content::{packs, recipes};
    use crate::life::state::Vehicle;

    #[test]
    fn every_pack_recipe_makes_a_real_pack() {
        for r in recipes() {
            match (&r.makes.pack, &r.makes.item) {
                (Some(p), _) => assert!(content::has_pack_def(p), "{}", r.id),
                (None, Some(i)) => assert!(content::has_item_def(i), "{}", r.id),
                (None, None) => panic!("{} makes nothing", r.id),
            }
        }
        for p in packs() {
            for i in &p.inputs {
                assert!(content::has_item_def(&i.item), "{} needs {}", p.id, i.item);
            }
        }
    }

    #[test]
    fn a_merchant_sells_back_what_you_sold_them_until_you_walk_off() {
        let (mut life, mut world, mut p) = island(10.0);
        life.give("sunroot", 10, true);
        let price = js_max(1.0, js_round(item_def("sunroot").value * vendor_for("mara").unwrap().buy_rate));
        let held = |life: &Life| life.state.buyback.clone().unwrap_or_default();
        assert!(held(&life).is_empty());
        // Two sales of the same thing make one stack.
        assert!(sell(&mut life, "mara", "sunroot", 6));
        assert!(sell(&mut life, "mara", "sunroot", 1));
        assert_eq!(held(&life), [Buyback { npc: "mara".into(), item: "sunroot".into(), n: 7, price }]);
        // Some of it back, at what she paid.
        let coins = life.state.coins;
        assert!(buy_back(&mut life, "mara", "sunroot", 3));
        assert_eq!((life.count("sunroot"), life.state.coins, held(&life)[0].n), (6, coins - 3.0 * price, 4));
        // Only what you sold her, and only with the coin for it.
        assert!(!buy_back(&mut life, "mara", "barley", 1));
        assert!(!buy_back(&mut life, "tamsin", "sunroot", 1));
        assert!(!buy_back(&mut life, "mara", "sunroot", 0));
        life.state.coins = 0.0;
        toasts(&mut life);
        assert!(!buy_back(&mut life, "mara", "sunroot", 1));
        assert_eq!(toasts(&mut life), ["Not enough coin to buy back Sunroot"]);
        // Asking for more than she holds buys what there is.
        life.state.coins = 100.0;
        assert!(buy_back(&mut life, "mara", "sunroot", 50));
        assert_eq!(life.count("sunroot"), 10);
        assert!(held(&life).is_empty());
        // Walk off and she lets go of it.
        assert!(sell(&mut life, "mara", "sunroot", 2));
        let mara = life.zone.recipe.npcs.iter().find(|n| n.id == "mara").unwrap().clone();
        let sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        (sim.player.pos.x, sim.player.pos.z) = (mara.x + BUYBACK_RANGE - 1.0, mara.z);
        step_buyback(&mut life, &sim);
        assert_eq!(held(&life).len(), 1, "still at her stall");
        sim.player.pos.x = mara.x + BUYBACK_RANGE + 1.0;
        step_buyback(&mut life, &sim);
        assert!(held(&life).is_empty());
        // The last twelve sales are held, the oldest going first.
        life.state.buyback = Some((0..12).map(|i| Buyback { npc: "mara".into(), item: format!("old{i}"), n: 1, price: 1.0 }).collect());
        assert!(sell(&mut life, "mara", "sunroot", 1));
        let list = held(&life);
        assert_eq!((list.len(), list[0].item.as_str(), list[11].item.as_str()), (12, "old1", "sunroot"));
    }

    #[test]
    fn crafting_a_pack_takes_the_goods_the_fee_and_the_labor() {
        let (mut life, mut world, mut p) = island(1000.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        // Without the goods nothing is spent.
        assert!(!run_recipe(&mut life, &mut sim, "pack.harvestCrate"));
        assert_eq!(toasts(&mut life).last().unwrap(), "Needs 6 Sunroot (you have 0)");
        life.give("sunroot", 6, true);
        life.give("barley", 5, true);
        assert!(run_recipe(&mut life, &mut sim, "pack.harvestCrate"));
        assert_eq!((life.count("sunroot"), life.count("barley")), (0, 1));
        assert_eq!((life.state.coins, life.state.labor), (980.0, 780.0));
        let pk = &life.state.packs[carried(&life, &sim).expect("on your back")];
        assert_eq!((pk.def.as_str(), pk.origin.as_str(), pk.at.as_str(), pk.made), ("harvestCrate", "lanternwick", "back", 0.0));
        assert_eq!(toasts(&mut life), ["📦 Lanternwick Harvest Crate packed - it's on your back"]);
        // One at a time on your back, and only standing at the bench.
        life.give("sunroot", 6, true);
        life.give("barley", 4, true);
        assert!(!run_recipe(&mut life, &mut sim, "pack.harvestCrate"));
        assert_eq!(toasts(&mut life), ["Your back is already full - set that pack down first (X)"]);
        consume_carried(&mut life, &mut sim);
        sim.player.mode = Mode::Swim;
        assert!(!run_recipe(&mut life, &mut sim, "pack.harvestCrate"));
        assert_eq!(toasts(&mut life), ["Stand still at the bench to work"]);
        assert_eq!(life.count("sunroot"), 6);
        // Unknown recipes do nothing.
        assert!(!run_recipe(&mut life, &mut sim, "pack.nothing"));
    }

    #[test]
    fn crafting_an_item_makes_it_for_the_bag() {
        let (mut life, mut world, mut p) = island(100.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        life.give("herbs", 7, true);
        toasts(&mut life);
        assert!(run_recipe(&mut life, &mut sim, "craft.tonic"));
        assert_eq!((life.count("herbs"), life.count("tonic.labor")), (2, 1));
        assert_eq!((life.state.coins, life.state.labor), (80.0, 795.0));
        assert_eq!(toasts(&mut life), ["+1 🧪 Hearty Tonic"]);
        life.state.coins = 5.0;
        life.give("herbs", 3, true);
        assert!(!run_recipe(&mut life, &mut sim, "craft.tonic"));
        assert_eq!(toasts(&mut life), ["Not enough coin to make Hearty Tonic"]);
        assert_eq!(life.count("herbs"), 5);
    }

    #[test]
    fn freshness_sours_from_the_bonus_to_the_penalty() {
        assert!((freshness(0.0) - 1.15).abs() < 1e-12);
        assert!((freshness(600.0) - 1.15).abs() < 1e-12);
        assert!((freshness(1650.0) - 1.015).abs() < 1e-12);
        assert!((freshness(2700.0) - 0.88).abs() < 1e-12);
        assert!((freshness(1e6) - 0.88).abs() < 1e-12);
    }

    #[test]
    fn selling_pays_by_route_demand_and_freshness_and_lowers_demand() {
        let (mut life, mut world, mut p) = island(0.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        toasts(&mut life);
        // Fresh, at the starting demand, on the 1x route: 260 x 1.1 x 1.15.
        sim.player.pack = make_pack(&mut life, "harvestCrate", "lanternwick");
        let q = quote(&life, &life.state.packs[0], "westwatch").unwrap();
        assert_eq!((q.coins, q.seals, q.factor), (329.0, 1.0, 1.0));
        assert!(sell_pack(&mut life, &mut sim, "westwatch"));
        assert_eq!((life.state.coins, life.state.seals), (329.0, 1.0));
        assert_eq!((life.state.stats.delivered, life.state.stats.earned), (1.0, 329.0));
        assert!((demand_at(&life, "westwatch", "harvestCrate") - 1.05).abs() < 1e-12);
        assert!(life.state.packs.is_empty() && sim.player.pack == 0);
        let events = life.drain_events();
        assert!(events.contains(&LifeEvent::Sold {
            pack: "harvestCrate".into(),
            coins: 329.0,
            seals: 1.0,
            demand: q.demand,
            fresh: q.fresh,
            outpost: "westwatch".into()
        }));
        assert!(events.contains(&LifeEvent::Toast { text: "Sold Lanternwick Harvest Crate: 3s 29c + 1 seal".into(), kind: "coin".into() }));
        // The next one there fetches less.
        sim.player.pack = make_pack(&mut life, "harvestCrate", "lanternwick");
        assert_eq!(quote(&life, &life.state.packs[0], "westwatch").unwrap().coins, 314.0);
        // Gullrock pays half again and three seals; a pack left to go stale pays less.
        life.state.clock = 2700.0;
        let q = quote(&life, &life.state.packs[0], "gullrock").unwrap();
        assert_eq!((q.coins, q.seals, q.factor), (378.0, 3.0, 1.5));
        assert!(sell_pack(&mut life, &mut sim, "gullrock"));
        assert_eq!((life.state.coins, life.state.seals), (707.0, 4.0));
        assert_eq!(toasts(&mut life), ["Sold Lanternwick Harvest Crate: 3s 78c + 3 seals"]);
        // Nobody buys a pack where it was made, or building materials.
        sim.player.pack = make_pack(&mut life, "harvestCrate", "lanternwick");
        assert!(!sell_pack(&mut life, &mut sim, "lanternwick"));
        assert_eq!(toasts(&mut life), ["Lanternwick makes these itself - sell it somewhere else"]);
        consume_carried(&mut life, &mut sim);
        sim.player.pack = make_pack(&mut life, "lumberBundle", "thornwood");
        assert!(quote(&life, &life.state.packs[0], "westwatch").is_none());
        assert!(!sell_pack(&mut life, &mut sim, "westwatch"));
        assert_eq!(toasts(&mut life), ["Westwatch Trading Post does not buy Lumber Bundle"]);
        assert_ne!(sim.player.pack, 0);
        // Demand comes back with time, up to its ceiling.
        recover_demand(&mut life, 60.0);
        assert!((demand_at(&life, "westwatch", "harvestCrate") - 1.07).abs() < 1e-12);
        recover_demand(&mut life, 3600.0);
        assert_eq!(demand_at(&life, "westwatch", "harvestCrate"), 1.3);
        assert_eq!(demand_at(&life, "westwatch", "flaxBale"), 1.1);
    }

    #[test]
    fn vendors_sell_for_coin_and_seals_and_buy_back_at_their_rate() {
        let (mut life, _, _) = island(1000.0);
        toasts(&mut life);
        assert!(buy(&mut life, "mara", "seed.sunroot", 3));
        assert_eq!((life.count("seed.sunroot"), life.state.coins), (3, 988.0));
        assert_eq!(toasts(&mut life), ["+3 🌱 Sunroot Seeds"]);
        // Not hers to sell, nobody's stall, nothing asked for.
        assert!(!buy(&mut life, "mara", "blueprint.cottage", 1));
        assert!(!buy(&mut life, "nobody", "seed.sunroot", 1));
        assert!(!buy(&mut life, "mara", "seed.sunroot", 0));
        assert!(!buy(&mut life, "mara", "seed.sunroot", -4));
        // A blueprint costs Charter Seals as well.
        assert!(!buy(&mut life, "quill", "blueprint.cottage", 1));
        assert_eq!(toasts(&mut life), ["Not enough Charter Seals to buy Cottage Blueprint"]);
        life.state.seals = 3.0;
        assert!(buy(&mut life, "quill", "blueprint.cottage", 1));
        assert_eq!((life.state.coins, life.state.seals), (688.0, 0.0));
        // Mara buys produce at 60% of its value: an apple (5c) fetches 3c. All you have, no more.
        life.give("apple", 4, true);
        toasts(&mut life);
        assert!(sell(&mut life, "mara", "apple", 10));
        assert_eq!((life.count("apple"), life.state.coins), (0, 700.0));
        assert_eq!(toasts(&mut life), ["Sold 4 Redcap Apple for 12c"]);
        assert!(!sell(&mut life, "mara", "apple", 1));
        life.give("sunroot", 2, true);
        assert!(!sell(&mut life, "quill", "sunroot", 1));
        assert!(!sell(&mut life, "nobody", "sunroot", 1));
        // Sunroot (2c) fetches a copper each.
        assert!(sell(&mut life, "mara", "sunroot", 2));
        assert_eq!(life.state.coins, 702.0);
        // Asking for an absurd number is just too many to carry.
        toasts(&mut life);
        assert!(!buy(&mut life, "mara", "seed.sunroot", i64::MAX));
        assert_eq!(toasts(&mut life), ["Your bag is full"]);
        assert_eq!((life.count("seed.sunroot"), life.state.coins), (3, 702.0));
        // A full bag takes nothing more.
        life.state.bag.clear();
        for i in 0..crate::life::content::bag_slots() {
            life.state.bag.push(crate::life::state::Stack { item: format!("filler{i}"), n: 1 });
        }
        toasts(&mut life);
        assert!(!buy(&mut life, "mara", "seed.barley", 1));
        assert_eq!(toasts(&mut life), ["Your bag is full"]);
        assert_eq!(life.state.coins, 702.0);
    }

    #[test]
    fn packs_go_down_on_the_ground_into_cargo_and_back() {
        let (mut life, mut world, mut p) = island(0.0);
        p.facing = std::f64::consts::FRAC_PI_2;
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        life.state.vehicles.push(Vehicle { id: 500, def: "farmCart".into(), cargo: vec![0, 0], ..Default::default() });
        let id = make_pack(&mut life, "flaxBale", "lanternwick");
        sim.player.pack = id;
        // Set down in front of you, on the ground there.
        let (x, y, z) = (sim.player.pos.x + 0.9, sim.player.pos.y, sim.player.pos.z);
        assert!(drop_pack(&mut life, &mut sim));
        let pk = &life.state.packs[0];
        assert_eq!((pk.at.as_str(), sim.player.pack), ("ground", 0));
        assert!((pk.x - x).abs() < 1e-9 && (pk.z - z).abs() < 1e-9);
        assert_eq!(pk.y, ground_at(sim.terrain(), &sim.world.index, pk.x, pk.z, y + 0.3, 0.6));
        assert_eq!(pk.rot, std::f64::consts::FRAC_PI_2);
        assert!(!drop_pack(&mut life, &mut sim));
        // Up again, into the cart, and out.
        assert!(pick_up(&mut life, &mut sim, id));
        assert_eq!((sim.player.pack, life.state.packs[0].at.as_str()), (id, "back"));
        assert!(load_pack(&mut life, &mut sim, 500, 0));
        let pk = &life.state.packs[0];
        assert_eq!((pk.at.as_str(), pk.vehicle, pk.slot, sim.player.pack), ("cargo", 500, 0, 0));
        assert_eq!(life.state.vehicles[0].cargo, [id, 0]);
        assert!(!load_pack(&mut life, &mut sim, 500, 1), "nothing on your back");
        assert!(unload_pack(&mut life, &mut sim, 500, 0));
        assert_eq!((sim.player.pack, life.state.packs[0].at.as_str(), life.state.packs[0].vehicle), (id, "back", 0));
        assert_eq!(life.state.vehicles[0].cargo, [0, 0]);
        toasts(&mut life);
        assert!(!unload_pack(&mut life, &mut sim, 500, 0));
        assert_eq!(toasts(&mut life), ["Your back is already full"]);
        // Not in water, and nothing that isn't there.
        sim.player.mode = Mode::Swim;
        assert!(!drop_pack(&mut life, &mut sim));
        assert_eq!(toasts(&mut life), ["You cannot set a pack down here"]);
        assert!(!pick_up(&mut life, &mut sim, 12345));
        assert!(!load_pack(&mut life, &mut sim, 12345, 0));
        assert!(!load_pack(&mut life, &mut sim, 500, 9));
        assert!(!unload_pack(&mut life, &mut sim, 500, 9));
    }
}
