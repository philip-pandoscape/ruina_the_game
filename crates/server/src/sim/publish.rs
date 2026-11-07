//! What a tick produced, as data for the gates: everyone and everything others may see, packed once
//! each into the 32 m cell it stands in (the wire for crowds' records, crates/wire: players, bots,
//! creatures, vehicles, packs on the ground, arrows, meteors and the effects others see), the
//! mini-games' tables, and each player's private state (their own player, their life when it
//! changed, what happened to them). Built once a tick, whoever is watching; each gate writes its
//! clients' updates from it (crate::gate::encode). Lives due a save go to the game's `writes`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use ruina_wire::pack;
use ruina_wire::schema::Kind;
use ruina_world_api::EntityId;
use ruina_world_api::records::{Frame, LifeView, Private, Stats, TableRecord, TickOut, You};
use ruina_world_api::store::Then;

use super::{Game, LIFE_EVERY, SAVE_EVERY, STATS_EVERY, client, island_of, outside_of};
use crate::gate::encode::wire_id;

impl Game {
    /// What this tick produced (`now`).
    pub(super) fn publish(&mut self, now: Instant) -> TickOut {
        let ids: Vec<i64> = self.members.keys().copied().collect();
        for id in &ids {
            self.refresh_estate(*id);
        }
        let frame = self.frame();
        let tables = self.tables.tables.iter().map(|t| TableRecord { x: t.at.x, z: t.at.z, shown: t.shown() }).collect();

        // Once a second, for admins: how this game is running and how its fights go.
        let stats = self.tick.is_multiple_of(STATS_EVERY).then(|| {
            // Every tick since the last stats, the rules and the publishing apart: [ms, ms] each.
            let ticks = std::mem::take(&mut self.timed);
            let pl = &self.players;
            Stats {
                tick: self.tick,
                players: self.members.len(),
                bots: self.bots.len(),
                tick_ms: self.step_ms,
                ticks,
                pvp_hits: pl.pvp_hits,
                saved_by_rewind: pl.saved_by_rewind,
                rewind_ms: pl.rewind_ms(),
                heals: pl.heals,
                meteors_landed: pl.meteors_landed,
            }
        });

        // What each player alone is sent, and whose life is due a save.
        let outside = self.outside();
        let mut private = Vec::with_capacity(ids.len());
        let mut saves = Vec::new();
        for id in ids {
            let c = client(id);
            let Some(slot) = self.players.slot_index(c) else { continue };
            let Some((p, ack, Some(life))) = self.players.open_view(c) else { continue };
            let you = You::of(slot, ack, p, life);
            let rev = life.revision;
            let m = self.members.get_mut(&id).expect("a member");
            let send_life = m.life_due > 0 || rev != m.last_rev || now - m.last_life >= LIFE_EVERY;
            let life_view = send_life.then(|| LifeView::of(life));
            let save_due = now - m.last_save >= SAVE_EVERY && !m.keep_saved;
            m.life_due = m.life_due.saturating_sub(1);
            if send_life {
                m.last_rev = rev;
                m.last_life = now;
            }
            if save_due {
                m.last_save = now;
            }
            let (epoch, home, conn) = (m.epoch, m.home.clone(), m.conn);
            let told = self.players.told(slot).iter().map(pack::effect).collect();
            let mut life_events = Vec::new();
            if let Some((p, Some(life))) = self.players.open_mut(c) {
                life_events = life.drain_events();
                if save_due {
                    let island = outside_of(island_of(p, life, &mut self.open, id), outside);
                    saves.push(self.life_write(id, epoch, &home, island, Some(conn)));
                }
            }
            private.push(Private { character: id, you, life: life_view, life_events, told });
        }
        private.sort_by_key(|p| p.character);
        for s in saves {
            self.writes.push((vec![s], Then::Nothing));
        }
        TickOut { sim: self.sim, lease: self.lease, space: Some(self.at.clone()), tick: self.tick, frame, tables, private, stats }
    }

    /// Everything others may see this tick, each packed once into its cell (crates/wire's records):
    /// players and bots with what of their lives others see (the vehicles they have out, the packs
    /// they left on the ground), the creatures, arrows and meteors, and the effects shown.
    pub(super) fn frame(&self) -> Frame {
        let mut frame = Frame::new(self.tick);
        // Names once a tick: a bot's from the bots' list by its id, not by looking through it.
        let bot_names: HashMap<EntityId, &str> = self.bots.iter().map(|b| (b.entity, b.name.as_str())).collect();
        let mut by_slot: HashMap<usize, u64> = HashMap::new();
        for (entity, owner, p, life) in self.players.each_open() {
            let (name, bot) = match self.members.get(&owner) {
                Some(m) => (m.name.as_str(), false),
                None => match bot_names.get(&entity) {
                    Some(n) => (*n, true),
                    None => continue,
                },
            };
            if let Some(slot) = self.players.slot_index(entity) {
                by_slot.insert(slot, entity.raw());
            }
            let id = wire_id(entity);
            let carried = (p.pack != 0).then(|| life.and_then(|l| l.state.packs.iter().find(|pk| pk.id == p.pack))).flatten().map(|pk| pk.def.as_str());
            let host = if p.host != 0 { EntityId::character(p.host).raw() } else { 0 };
            frame.push(pack::player(entity.raw(), id, Arc::from(name), bot, p, carried, host));
            let Some(life) = life else { continue };
            for v in &life.state.vehicles {
                frame.push(pack::vehicle(pack::owned_key(Kind::Vehicle, id, v.id), entity.raw(), id, v, &life.state.packs));
            }
            for pk in life.state.packs.iter().filter(|pk| pk.at == "ground") {
                frame.push(pack::item(pack::owned_key(Kind::Item, id, pk.id), entity.raw(), id, pk));
            }
        }
        for a in &self.actors.list {
            if let Some(r) = pack::creature(EntityId::creature(a.id).raw(), a) {
                frame.push(r);
            }
        }
        for a in self.players.arrows() {
            let shooter = by_slot.get(&usize::from(a.owner)).copied().unwrap_or(0);
            frame.push(pack::arrow(pack::key(Kind::Arrow, i64::from(a.id)), a, shooter));
        }
        for m in self.players.meteors() {
            frame.push(pack::meteor(pack::key(Kind::Meteor, i64::from(m.id)), m));
        }
        for e in self.players.shown() {
            frame.event(pack::effect(e));
        }
        frame
    }
}
