//! What a browser hears, encoded: today the JSON it has always read (src/net/worldLink.ts). A
//! client's update is built here from a simulation's tick (its records by cell, and this client's
//! private state: `tick`), and every other message from the tiers' words to it (`message`). The
//! binary protocol (crates/wire) takes this module's place: these two functions are all the gate
//! asks of an encoding. What a browser's input bytes mean is world-api's (`input`).

use serde::Serialize;
use serde_json::Value;

use ruina_world_api::gate::ToConn;
use ruina_world_api::records::{Cell, CreatureRecord, EffectRecord, Presence, Private, Stats, TickOut, You, cells_round};
use ruina_world_api::{EntityId, EntityKind};

use crate::sim::tables::SHOW_TABLES;

/// Monsters and other creatures further than this aren't sent, and at most so many.
const ACTOR_RADIUS: f64 = 70.0;
const ACTOR_CAP: usize = 48;
/// Arrows, meteors and effects within this distance of a player are sent to them, at most so many.
const EFFECT_RADIUS: f64 = 90.0;
const ARROW_CAP: usize = 64;
const METEOR_CAP: usize = 16;
const EFFECT_CAP: usize = 48;

/// How a browser names someone: a character by their id, a bot by its number below every
/// character's, a creature by its number. (The wire's handles per connection take its place.)
pub fn wire_id(id: EntityId) -> i64 {
    match id.kind() {
        Some(EntityKind::Character) => id.number() as i64,
        Some(EntityKind::Bot) => crate::sim::FIRST_BOT - i64::from(id.as_bot().map_or(0, |(_, n)| n)),
        _ => id.number() as i64,
    }
}

/// Rounded to the centimetre: what the browser needs of a position or a speed, in fewer bytes.
fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize)]
struct Peer<'a> {
    id: i64,
    name: &'a str,
    #[serde(skip_serializing_if = "is_false")]
    bot: bool,
    p: &'a Presence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Actor {
    id: i64,
    kind: u8,
    x: f64,
    y: f64,
    z: f64,
    facing: f64,
    state: usize,
    progress: f64,
    hp: f64,
    dead_frame: i32,
    target_x: f64,
    target_z: f64,
}

impl Actor {
    fn of(a: &CreatureRecord) -> Actor {
        Actor {
            id: wire_id(a.id),
            kind: a.kind,
            x: a.x,
            y: a.y,
            z: a.z,
            facing: a.facing,
            state: a.state,
            progress: a.progress,
            hp: a.hp,
            dead_frame: a.dead_frame,
            target_x: a.target_x,
            target_z: a.target_z,
        }
    }
}

#[derive(Serialize)]
struct Arrow {
    id: u16,
    owner: u16,
    x: f64,
    y: f64,
    z: f64,
    vx: f64,
    vz: f64,
    team: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meteor {
    id: u16,
    x: f64,
    z: f64,
    ticks_left: u32,
    fall_ticks: u32,
    team: u8,
    radius: f64,
}

#[derive(Serialize)]
struct Event {
    kind: u16,
    x: f64,
    y: f64,
    z: f64,
    size: u8,
}

fn event(e: &EffectRecord) -> Event {
    Event { kind: e.kind, x: r2(e.x), y: r2(e.y), z: r2(e.z), size: e.size }
}

#[derive(Serialize)]
struct StatsOut {
    #[serde(flatten)]
    stats: Stats,
    bytes: usize,
}

/// A client's update (src/net/worldLink.ts WorldTick).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Update<'a> {
    t: &'static str,
    tick: u64,
    you: &'a You,
    peers: Vec<Peer<'a>>,
    actors: Vec<Actor>,
    arrows: Vec<Arrow>,
    meteors: Vec<Meteor>,
    events: Vec<Event>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    life_events: &'a [ruina_engine::life::LifeEvent],
    #[serde(skip_serializing_if = "Option::is_none")]
    life: Option<&'a ruina_world_api::records::LifeView>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tables: Vec<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<StatsOut>,
}

/// The cells of `out` within `radius` of (x, z).
fn cells_near(out: &TickOut, x: f64, z: f64, radius: f64) -> impl Iterator<Item = &Cell> {
    cells_round(x, z, radius).filter_map(move |at| out.cell(at))
}

/// One client's update from a tick: their own state; everyone else in the space; the creatures,
/// arrows, meteors, effects and tables near them; what happened to them; and once a second, for an
/// admin, how the simulation is running (with this update's size).
pub fn tick(out: &TickOut, me: &Private, admin: bool) -> String {
    let (x, z) = (me.you.p.pos.x, me.you.p.pos.z);
    let near = |px: f64, pz: f64, r: f64| (px - x) * (px - x) + (pz - z) * (pz - z) <= r * r;
    let mine = EntityId::character(me.character);
    // Everyone else in the space (the wire's interest tiers will send the far ones less).
    let peers =
        out.cells.iter().flat_map(|c| &c.players).filter(|p| p.id != mine).map(|p| Peer { id: wire_id(p.id), name: &p.name, bot: p.bot, p: &p.p }).collect();
    // The creatures within reach of being seen, nearest first.
    let mut creatures: Vec<(f64, &CreatureRecord)> = cells_near(out, x, z, ACTOR_RADIUS)
        .flat_map(|c| &c.creatures)
        .map(|a| ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z), a))
        .filter(|(d2, _)| *d2 <= ACTOR_RADIUS * ACTOR_RADIUS)
        .collect();
    creatures.sort_by(|a, b| a.0.total_cmp(&b.0));
    creatures.truncate(ACTOR_CAP);
    let around: Vec<&Cell> = cells_near(out, x, z, EFFECT_RADIUS).collect();
    let arrows = around
        .iter()
        .flat_map(|c| &c.arrows)
        .filter(|a| near(a.x, a.z, EFFECT_RADIUS))
        .take(ARROW_CAP)
        .map(|a| Arrow { id: a.id, owner: a.owner, x: r2(a.x), y: r2(a.y), z: r2(a.z), vx: r2(a.vx), vz: r2(a.vz), team: a.team })
        .collect();
    let meteors = around
        .iter()
        .flat_map(|c| &c.meteors)
        .filter(|m| near(m.x, m.z, EFFECT_RADIUS))
        .take(METEOR_CAP)
        .map(|m| Meteor { id: m.id, x: r2(m.x), z: r2(m.z), ticks_left: m.ticks_left, fall_ticks: m.fall_ticks, team: m.team, radius: r2(m.radius) })
        .collect();
    let mut events: Vec<Event> = around.iter().flat_map(|c| &c.effects).filter(|e| near(e.x, e.z, EFFECT_RADIUS)).take(EFFECT_CAP).map(event).collect();
    events.extend(me.told.iter().map(event));
    let tables = cells_near(out, x, z, SHOW_TABLES).flat_map(|c| &c.tables).filter(|t| near(t.x, t.z, SHOW_TABLES)).map(|t| &t.shown).collect();
    let mut update = Update {
        t: "tick",
        tick: out.tick,
        you: &me.you,
        peers,
        actors: creatures.into_iter().map(|(_, a)| Actor::of(a)).collect(),
        arrows,
        meteors,
        events,
        life_events: &me.life_events,
        life: me.life.as_ref(),
        tables,
        stats: None,
    };
    let text = serde_json::to_string(&update).unwrap_or_default();
    match (admin, out.stats) {
        // With the size of this very update, before the stats were added to it.
        (true, Some(stats)) => {
            update.stats = Some(StatsOut { stats, bytes: text.len() });
            serde_json::to_string(&update).unwrap_or_default()
        }
        _ => text,
    }
}

/// What a browser is told, as it reads it; None for what passes between the tiers on its way in.
pub fn message(msg: &ToConn) -> Option<String> {
    use serde_json::json;
    let v = match msg {
        ToConn::Claimed(_) | ToConn::Life { .. } | ToConn::Arrived { .. } | ToConn::Estates(_) | ToConn::Turned { .. } => return None,
        ToConn::Moved { space, .. } => json!({ "t": "space", "space": space }),
        ToConn::Kicked => json!({ "t": "kicked" }),
        ToConn::Saved { at } => json!({ "t": "saved", "at": at }),
        ToConn::Reset => json!({ "t": "reset" }),
        ToConn::Error { text } => json!({ "t": "error", "text": text }),
        ToConn::Notice { text } => json!({ "t": "notice", "text": text }),
        ToConn::Left { id } => json!({ "t": "left", "id": wire_id(*id) }),
        ToConn::Estate { id, name, estate } => json!({ "t": "estate", "id": id, "name": name, "estate": estate }),
        ToConn::Claims { claims } => json!({ "t": "claims", "claims": claims }),
        ToConn::Challenges { sent, waiting } => json!({ "t": "challenges", "sent": sent, "waiting": waiting }),
        ToConn::Table { table } => json!({ "t": "table", "table": table }),
        ToConn::Party { party } => json!({ "t": "party", "party": party }),
        ToConn::PartyInvite { invite } => json!({ "t": "partyInvite", "invite": invite }),
    };
    Some(v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruina_world_api::gate::SpaceView;
    use ruina_world_api::records::{ArrowRecord, PlayerState, PresenceRecord, TableRecord, cell_of};
    use ruina_world_api::{SimId, SpaceId};

    fn private(character: i64, x: f64, z: f64) -> Private {
        let mut p = crate::player::Player::new(crate::world::Spawn { x, z, facing: 0.0 }, 0, crate::player::Build::default());
        p.pos.y = 1.0;
        let life = crate::life::Life::new(crate::open::zone::emberholm(), None, None);
        Private { character, you: You::of(3, 9, &p, &life), life: None, life_events: Vec::new(), told: Vec::new() }
    }

    fn presence(id: EntityId, name: &str, bot: bool, x: f64, z: f64) -> PresenceRecord {
        let p = crate::player::Player::new(crate::world::Spawn { x, z, facing: 0.0 }, 0, crate::player::Build::default());
        PresenceRecord { id, name: name.into(), bot, p: Presence::of(&p, None, 30) }
    }

    fn put(out: &mut TickOut, x: f64, z: f64, f: impl FnOnce(&mut Cell)) {
        let at = cell_of(x, z);
        let k = match out.cells.binary_search_by_key(&at, |c| c.at) {
            Ok(k) => k,
            Err(k) => {
                out.cells.insert(k, Cell { at, ..Cell::default() });
                k
            }
        };
        f(&mut out.cells[k]);
    }

    #[test]
    fn an_update_has_everyone_and_what_is_near_in_the_shape_the_browser_reads() {
        let mut out = TickOut { sim: SimId(1), space: Some(SpaceId::channel("emberholm", 1)), tick: 77, ..TickOut::default() };
        let me = private(7, 0.0, 0.0);
        out.private.push(me.clone());
        put(&mut out, 0.0, 0.0, |c| c.players.push(presence(EntityId::character(7), "Ada", false, 0.0, 0.0)));
        // Someone far off is still a peer; a bot is marked as one.
        put(&mut out, 500.0, 500.0, |c| c.players.push(presence(EntityId::character(8), "Bo", false, 500.0, 500.0)));
        put(&mut out, 3.0, 0.0, |c| c.players.push(presence(EntityId::bot(1, 4), "Skirmisher 4", true, 3.0, 0.0)));
        // An arrow near, and one too far to be sent.
        for (x, id) in [(10.0, 1), (200.0, 2)] {
            put(&mut out, x, 0.0, |c| c.arrows.push(ArrowRecord { id, owner: 0, x: x + 0.123, y: 1.3, z: 0.0, vx: 30.0, vz: 0.0, team: 0 }));
        }
        put(&mut out, 20.0, 20.0, |c| c.tables.push(TableRecord { x: 20.0, z: 20.0, shown: serde_json::json!({ "board": 1 }) }));
        let v: Value = serde_json::from_str(&tick(&out, &me, false)).unwrap();
        assert_eq!((v["t"].as_str(), v["tick"].as_u64()), (Some("tick"), Some(77)));
        assert_eq!((v["you"]["id"].as_u64(), v["you"]["ack"].as_u64()), (Some(3), Some(9)));
        assert_eq!(v["you"]["p"]["mode"], "normal");
        let peers = v["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 2, "everyone but you");
        let bot = peers.iter().find(|p| p["bot"] == true).expect("the bot");
        assert_eq!(bot["id"], crate::sim::FIRST_BOT - 4);
        assert!(peers.iter().any(|p| p["id"] == 8 && p.get("bot").is_none()));
        assert_eq!(v["arrows"].as_array().unwrap().len(), 1);
        assert_eq!(v["arrows"][0]["x"], 10.12, "to the centimetre");
        assert_eq!(v["tables"][0]["board"], 1);
        assert!(v.get("stats").is_none() && v.get("life").is_none() && v.get("lifeEvents").is_none());
        // An admin, once a second, has the stats with the size of the update.
        out.stats = Some(Stats { tick: 77, players: 1, ..Stats::default() });
        let plain = tick(&out, &me, false).len();
        let v: Value = serde_json::from_str(&tick(&out, &me, true)).unwrap();
        assert_eq!(v["stats"]["bytes"].as_u64(), Some(plain as u64));
        assert_eq!(v["stats"]["players"], 1);
    }

    #[test]
    fn messages_read_as_they_always_have() {
        let m = |msg: ToConn| serde_json::from_str::<Value>(&message(&msg).unwrap()).unwrap();
        assert_eq!(m(ToConn::Saved { at: 5 }), serde_json::json!({ "t": "saved", "at": 5 }));
        assert_eq!(m(ToConn::Left { id: EntityId::bot(2, 1) })["id"], crate::sim::FIRST_BOT - 1);
        assert_eq!(
            m(ToConn::Moved { sim: SimId(3), space: SpaceView::Channel { channel: 2 } }),
            serde_json::json!({ "t": "space", "space": { "kind": "channel", "channel": 2 } })
        );
        assert!(message(&ToConn::Turned { text: "no".into() }).is_none());
        let _ = PlayerState::of;
    }
}
