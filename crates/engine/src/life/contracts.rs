//! Trade contracts posted at the trading posts (their shape for the page: src/engine/life/contracts.ts).
//!
//! Each trading post posts a couple of requests for specific packs ("three Flax Bales within 25
//! minutes"). Take one on, fill it before it runs out, and the post pays bonus Charter Seals and
//! coin on top of each pack's normal price. Pack running with a goal.

use super::content::{contracts, format_coins, pack_def, packs, place_name, route};
use super::state::{Contract, ContractState};
use super::{Life, QuestEvent};
use crate::jsmath::{js_max, js_round};

/// Packs a trading post will buy (any trade pack with a route to it).
fn wanted(outpost: &str) -> Vec<&'static str> {
    packs().iter().filter(|p| p.kind.as_deref() != Some("material") && route(&p.origin, outpost).is_some()).map(|p| p.id.as_str()).collect()
}

pub fn step_contracts(life: &mut Life) {
    // Held apart while the board changes (posting draws on the life's randomness and ids), then
    // put back; nothing in between reads it.
    let mut c = life.state.contracts.take().unwrap_or_default();
    refresh(life, &mut c);
    life.state.contracts = Some(c);
}

fn refresh(life: &mut Life, c: &mut ContractState) {
    let cfg = contracts();
    let now = life.state.clock;
    for k in c.active.iter().filter(|k| k.expires <= now) {
        life.toast(format!("Contract lapsed: {} × {} for {}", k.count, pack_def(&k.pack).name, place_name(&k.outpost)), "bad");
    }
    c.active.retain(|k| k.expires > now);
    c.offered.retain(|k| k.expires > now);
    if now < c.next_refresh {
        return;
    }
    c.next_refresh = now + cfg.refresh_seconds;
    // Every trading post in the world takes contracts, wherever you are.
    for o in crate::open::map::world_map().recipes().flat_map(|r| &r.outposts) {
        let options = wanted(&o.id);
        while c.offered.iter().filter(|k| k.outpost == o.id).count() < cfg.per_outpost && !options.is_empty() {
            let pack = options[(life.rand() * options.len() as f64).floor() as usize];
            let count = life.rand_int(cfg.count[0], cfg.count[1]);
            let def = pack_def(pack);
            // Always there: wanted() only lists packs with a route here.
            let Some(r) = route(&def.origin, &o.id) else { break };
            c.offered.push(Contract {
                id: life.next_id(),
                outpost: o.id.clone(),
                pack: pack.to_string(),
                count,
                delivered: 0,
                bonus_coins: js_round(def.base * r.factor * cfg.coin_bonus * count as f64),
                bonus_seals: js_max(1.0, js_round(cfg.seals_per_pack * count as f64 * r.factor)),
                expires: now + cfg.duration_seconds + cfg.refresh_seconds,
            });
        }
    }
}

pub fn accept_contract(life: &mut Life, id: i64) -> bool {
    let cfg = contracts();
    let clock = life.state.clock;
    let c = life.state.contracts.get_or_insert_with(ContractState::default);
    let Some(mut k) = c.offered.iter().find(|x| x.id == id).cloned() else { return false };
    if c.active.len() >= cfg.max_active {
        life.toast(format!("You can hold {} contracts at a time", cfg.max_active), "bad");
        return false;
    }
    c.offered.retain(|x| x.id != id);
    k.expires = clock + cfg.duration_seconds;
    let text = format!("Contract taken: {} × {} to {}", k.count, pack_def(&k.pack).name, place_name(&k.outpost));
    c.active.push(k);
    life.toast(text, "quest");
    true
}

/// A pack was just sold at an outpost: count it toward a matching contract.
pub fn contract_delivered(life: &mut Life, outpost: &str, pack: &str) {
    let Some(c) = life.state.contracts.as_mut() else { return };
    let Some(k) = c.active.iter_mut().find(|x| x.outpost == outpost && x.pack == pack && x.delivered < x.count) else { return };
    k.delivered += 1;
    if k.delivered < k.count {
        let text = format!("Contract: {}/{} {}", k.delivered, k.count, pack_def(pack).name);
        life.toast(text, "quest");
        return;
    }
    let (id, coins, seals) = (k.id, k.bonus_coins, k.bonus_seals);
    life.state.coins += coins;
    life.state.seals += seals;
    c.active.retain(|x| x.id != id);
    life.record("bonus", format!("post:{outpost}"), coins, seals, Vec::new(), Some(pack.to_string()));
    life.toast(format!("✔ Contract filled! Bonus {} + {} seal{}", format_coins(coins), seals, if seals > 1.0 { "s" } else { "" }), "coin");
    life.notify(QuestEvent { outpost: Some(outpost.to_string()), ..QuestEvent::new("contract") });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::trade::testing::{new_life, toasts};
    use crate::life::trade::{make_pack, quote, sell_pack};
    use crate::open::Sim;

    fn board(life: &Life) -> &ContractState {
        life.state.contracts.as_ref().expect("the board is up")
    }

    #[test]
    fn each_trading_post_posts_contracts_for_packs_it_buys() {
        let (mut life, _, _) = new_life(0.0);
        assert!(life.state.contracts.is_none());
        step_contracts(&mut life);
        let c = board(&life);
        assert_eq!(c.next_refresh, 600.0);
        for o in &life.zone.recipe.outposts {
            let here: Vec<&Contract> = c.offered.iter().filter(|k| k.outpost == o.id).collect();
            assert_eq!(here.len(), 2, "{}", o.id);
            for k in here {
                let def = pack_def(&k.pack);
                let r = route(&def.origin, &o.id).expect("a pack it buys");
                assert!(def.kind.as_deref() != Some("material"));
                assert!((1..=3).contains(&k.count), "{}", k.count);
                assert_eq!(k.bonus_coins, js_round(def.base * r.factor * 0.3 * k.count as f64));
                assert_eq!(k.bonus_seals, js_max(1.0, js_round(k.count as f64 * r.factor)));
                assert_eq!((k.delivered, k.expires), (0, 2100.0));
            }
        }
        let ids: Vec<i64> = c.offered.iter().map(|k| k.id).collect();
        // Nothing new until the board refreshes; then it is topped up.
        life.state.clock = 599.0;
        step_contracts(&mut life);
        assert_eq!(board(&life).offered.iter().map(|k| k.id).collect::<Vec<_>>(), ids);
        let first = ids[0];
        assert!(accept_contract(&mut life, first));
        life.state.clock = 600.0;
        step_contracts(&mut life);
        let c = board(&life);
        assert_eq!(c.offered.len(), 4);
        assert!(c.offered.iter().all(|k| k.id != first) && c.offered.iter().filter(|k| !ids.contains(&k.id)).count() == 1);
        assert_eq!(c.next_refresh, 1200.0);
    }

    #[test]
    fn a_contract_is_taken_filled_and_pays_its_bonus() {
        let (mut life, mut world, mut p) = new_life(0.0);
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        step_contracts(&mut life);
        toasts(&mut life);
        let k = board(&life).offered.iter().find(|k| k.outpost == "westwatch").unwrap().clone();
        life.state.clock = 100.0;
        assert!(accept_contract(&mut life, k.id));
        assert!(!accept_contract(&mut life, k.id), "taken already");
        let c = board(&life);
        assert_eq!((c.offered.len(), c.active.len(), c.active[0].expires), (3, 1, 1600.0));
        assert_eq!(toasts(&mut life), [format!("Contract taken: {} × {} to Westwatch Trading Post", k.count, pack_def(&k.pack).name)]);
        // Each pack sold there counts, at its normal price; the last one pays the bonus too.
        let (mut coins, mut seals) = (0.0, 0.0);
        for n in 1..=k.count {
            sim.player.pack = make_pack(&mut life, &k.pack, "lanternwick");
            let q = quote(&life, &life.land.packs[0], "westwatch").unwrap();
            coins += q.coins;
            seals += q.seals;
            assert!(sell_pack(&mut life, &mut sim, "westwatch"));
            let said = toasts(&mut life);
            if n < k.count {
                assert_eq!(said.last().unwrap(), &format!("Contract: {n}/{} {}", k.count, pack_def(&k.pack).name));
                assert_eq!(board(&life).active[0].delivered, n);
            } else {
                let s = if k.bonus_seals > 1.0 { "s" } else { "" };
                assert_eq!(said.last().unwrap(), &format!("✔ Contract filled! Bonus {} + {} seal{s}", format_coins(k.bonus_coins), k.bonus_seals));
            }
        }
        assert!(board(&life).active.is_empty());
        assert_eq!((life.state.coins, life.state.seals), (coins + k.bonus_coins, seals + k.bonus_seals));
        // A sale nothing is waiting for counts toward nothing.
        contract_delivered(&mut life, "westwatch", &k.pack);
        assert_eq!(life.state.coins, coins + k.bonus_coins);
    }

    #[test]
    fn only_two_at_a_time_and_they_lapse() {
        let (mut life, _, _) = new_life(0.0);
        step_contracts(&mut life);
        let ids: Vec<i64> = board(&life).offered.iter().map(|k| k.id).collect();
        assert!(accept_contract(&mut life, ids[0]));
        assert!(accept_contract(&mut life, ids[1]));
        toasts(&mut life);
        assert!(!accept_contract(&mut life, ids[2]));
        assert_eq!(toasts(&mut life), ["You can hold 2 contracts at a time"]);
        assert!(!accept_contract(&mut life, 9999));
        let lapsing = board(&life).active[0].clone();
        life.state.clock = 1500.0;
        step_contracts(&mut life);
        assert!(board(&life).active.is_empty());
        let said = toasts(&mut life);
        assert_eq!(said.len(), 2);
        assert_eq!(said[0], format!("Contract lapsed: {} × {} for {}", lapsing.count, pack_def(&lapsing.pack).name, place_name(&lapsing.outpost)));
        // The ones still on the board lapse at their own time and are replaced.
        life.state.clock = 2100.0;
        step_contracts(&mut life);
        let c = board(&life);
        assert_eq!(c.offered.len(), 4);
        assert!(c.offered.iter().all(|k| !ids.contains(&k.id)));
    }

    #[test]
    fn no_board_no_counting() {
        let (mut life, _, _) = new_life(0.0);
        contract_delivered(&mut life, "westwatch", "harvestCrate");
        assert!(life.state.contracts.is_none());
        assert!(!accept_contract(&mut life, 1));
        assert_eq!(life.state.contracts, Some(ContractState::default()), "the board is made when you look at it");
    }
}
