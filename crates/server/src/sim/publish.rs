//! What a tick produced, as data for the gates: everyone's presence, the creatures, arrows, meteors,
//! effects and tables sorted into 32 m cells, and each player's private state (their own player,
//! their life when it changed, what happened to them). Built once a tick, whoever is watching; each
//! gate builds its clients' updates from it (crate::gate::encode). Lives due a save go to the
//! game's `writes`.

use std::collections::BTreeMap;
use std::time::Instant;

use ruina_world_api::FRAMES_PER_TICK;
use ruina_world_api::records::{
    ArrowRecord, Cell, CellKey, CreatureRecord, EffectRecord, LifeView, MeteorRecord, Presence, PresenceRecord, Private, Stats, TableRecord, TickOut, You,
    cell_of,
};
use ruina_world_api::store::Then;

use super::{Game, LIFE_EVERY, SAVE_EVERY, STATS_EVERY, client, island_of, outside_of};

impl Game {
    /// What this tick produced (`now`).
    pub(super) fn publish(&mut self, now: Instant) -> TickOut {
        let ids: Vec<i64> = self.members.keys().copied().collect();
        for id in &ids {
            self.refresh_estate(*id);
        }
        let mut cells: BTreeMap<CellKey, Cell> = BTreeMap::new();

        // Everyone as everyone else sees them.
        let fr = self.tick * FRAMES_PER_TICK;
        for (entity, owner, p, life) in self.players.each_open() {
            let (name, bot) = match self.members.get(&owner) {
                Some(m) => (m.name.clone(), false),
                None => match self.bot_name_of(entity) {
                    Some(n) => (n.to_string(), true),
                    None => continue,
                },
            };
            cell(&mut cells, p.pos.x, p.pos.z).players.push(PresenceRecord { id: entity, name, bot, p: Presence::of(p, life, fr) });
        }
        for a in self.actors.list.iter().filter(|a| !a.gone) {
            cell(&mut cells, a.x, a.z).creatures.push(CreatureRecord::of(a));
        }
        for a in self.players.arrows() {
            cell(&mut cells, a.x, a.z).arrows.push(ArrowRecord::of(a));
        }
        for m in self.players.meteors() {
            cell(&mut cells, m.x, m.z).meteors.push(MeteorRecord::of(m));
        }
        for e in self.players.shown() {
            cell(&mut cells, e.x, e.z).effects.push(EffectRecord::of(e));
        }
        for t in &self.tables.tables {
            cell(&mut cells, t.at.x, t.at.z).tables.push(TableRecord { x: t.at.x, z: t.at.z, shown: t.shown() });
        }

        // Once a second, for admins: how this game is running and how its fights go.
        let stats = self.tick.is_multiple_of(STATS_EVERY).then(|| {
            let pl = &self.players;
            Stats {
                tick: self.tick,
                players: self.members.len(),
                bots: self.bots.len(),
                tick_ms: self.step_ms,
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
            let told = self.players.told(slot).iter().map(EffectRecord::of).collect();
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
        TickOut { sim: self.sim, lease: self.lease, space: Some(self.at.clone()), tick: self.tick, cells: cells.into_values().collect(), private, stats }
    }
}

/// The cell (x, z) is in, made if nothing was in it yet.
fn cell(cells: &mut BTreeMap<CellKey, Cell>, x: f64, z: f64) -> &mut Cell {
    let at = cell_of(x, z);
    cells.entry(at).or_insert_with(|| Cell { at, ..Cell::default() })
}
