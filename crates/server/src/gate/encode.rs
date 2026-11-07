//! What a browser hears, encoded. Each tick a connection is sent two messages built from the
//! simulation's tick (`Encoder::tick`): the wire for crowds' binary update (crates/wire: everyone and
//! everything near it, by its own handles, as changes against what it acknowledged, within its byte
//! budget; one `Viewer` per connection), and a JSON tick with what's its alone or rare (its own
//! player, to check the browser's prediction against; its life when it changed and what its life
//! said; the mini-game tables near it; for an admin once a second, how the simulation is running).
//! Every other message goes from the tiers' words to JSON (`message`). What a browser's input bytes
//! mean is world-api's (`input`).

use serde::Serialize;
use serde_json::Value;

use ruina_wire::viewer::View;
use ruina_wire::{Ack, Event, Viewer};
use ruina_world_api::gate::ToConn;
use ruina_world_api::records::{LifeView, Private, Stats, TickOut, You};
use ruina_world_api::{CharacterId, EntityId, EntityKind};

use crate::sim::tables::SHOW_TABLES;

/// How a browser names someone: a character by their id, a bot by its number below every
/// character's, a creature by its number. Introductions on the wire carry it; records name things
/// by the connection's own handles.
pub fn wire_id(id: EntityId) -> i64 {
    match id.kind() {
        Some(EntityKind::Character) => id.number() as i64,
        Some(EntityKind::Bot) => crate::sim::FIRST_BOT - i64::from(id.as_bot().map_or(0, |(_, n)| n)),
        _ => id.number() as i64,
    }
}

#[derive(Serialize)]
struct StatsOut {
    #[serde(flatten)]
    stats: Stats,
    /// What this tick's messages to this connection came to: the binary update and the JSON tick.
    bytes: usize,
    wire: usize,
}

/// A client's JSON tick (src/net/worldLink.ts WorldTick): what's theirs alone, and the tables near.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Update<'a> {
    t: &'static str,
    tick: u64,
    you: &'a You,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    life_events: &'a [ruina_engine::life::LifeEvent],
    #[serde(skip_serializing_if = "Option::is_none")]
    life: Option<&'a LifeView>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tables: Vec<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<StatsOut>,
}

/// What a connection was owed from ticks it never got to see (it couldn't keep up: crate::gate
/// skipped them for it), to go with the next: what its life said, and what happened to it.
#[derive(Default)]
pub struct Owed {
    pub life_events: Vec<ruina_engine::life::LifeEvent>,
    pub told: Vec<Event>,
    pub life: Option<LifeView>,
}

impl Owed {
    /// Keeps what a skipped tick said to this player.
    pub fn keep(&mut self, me: &Private) {
        self.life_events.extend(me.life_events.iter().cloned());
        self.told.extend(me.told.iter().copied());
        if let Some(l) = &me.life {
            self.life = Some(l.clone());
        }
    }
}

/// One connection's encoding: its viewer on the wire for crowds, and whether it's an admin's.
pub struct Encoder {
    viewer: Viewer,
    admin: bool,
}

impl Encoder {
    /// For the connection playing `character`.
    pub fn new(character: CharacterId, admin: bool) -> Encoder {
        Encoder { viewer: Viewer::new(EntityId::character(character).raw()), admin }
    }

    /// One tick for this connection, given its private part (`me`) and what it was owed from ticks it
    /// missed: the binary update, then the JSON tick.
    pub fn tick(&mut self, out: &TickOut, me: &Private, owed: Owed) -> (Vec<u8>, String) {
        let (x, z) = (me.you.p.pos.x, me.you.p.pos.z);
        let told: Vec<Event> = if owed.told.is_empty() { me.told.clone() } else { owed.told.iter().chain(&me.told).copied().collect() };
        let bytes = self.viewer.update(&out.frame, View { x, z }, &told);
        let near = |px: f64, pz: f64, r: f64| (px - x) * (px - x) + (pz - z) * (pz - z) <= r * r;
        let tables = out.tables.iter().filter(|t| near(t.x, t.z, SHOW_TABLES)).map(|t| &t.shown).collect();
        let life_events: Vec<ruina_engine::life::LifeEvent> = owed.life_events.into_iter().chain(me.life_events.iter().cloned()).collect();
        let life = me.life.as_ref().or(owed.life.as_ref());
        let mut update = Update { t: "tick", tick: out.tick, you: &me.you, life_events: &life_events, life, tables, stats: None };
        let text = serde_json::to_string(&update).unwrap_or_default();
        let text = match (self.admin, &out.stats) {
            // With the size of what this tick sent, before the stats were added to it.
            (true, Some(stats)) => {
                update.stats = Some(StatsOut { stats: stats.clone(), bytes: text.len() + bytes.len(), wire: bytes.len() });
                serde_json::to_string(&update).unwrap_or_default()
            }
            _ => text,
        };
        (bytes, text)
    }

    /// A binary message from the browser, if it's an acknowledgement (8): its viewer measures
    /// against what it applied from now on. False if it isn't one.
    pub fn ack(&mut self, bytes: &[u8]) -> bool {
        match Ack::read(bytes) {
            Ok(a) => {
                self.viewer.ack(&a);
                true
            }
            Err(_) => false,
        }
    }

    /// The connection's player went to another space (after the JSON `space` message, as the browser
    /// forgets what it heard when it reads that): everything starts over.
    pub fn reset(&mut self) {
        self.viewer.reset();
    }

    /// The viewer's counts, for tests and measures.
    pub fn stats(&self) -> ruina_wire::viewer::Stats {
        self.viewer.stats
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
    use ruina_wire::heard::Heard;
    use ruina_wire::pack;
    use ruina_wire::record::Intro;
    use ruina_wire::schema::Kind;
    use ruina_world_api::gate::SpaceView;
    use ruina_world_api::records::{Frame, PlayerState, TableRecord};
    use ruina_world_api::{SimId, SpaceId};

    fn private(character: i64, x: f64, z: f64) -> Private {
        let mut p = crate::player::Player::new(crate::world::Spawn { x, z, facing: 0.0 }, 0, crate::player::Build::default());
        p.pos.y = 1.0;
        let life = crate::life::Life::new(crate::open::zone::emberholm(), None, None);
        Private { character, you: You::of(3, 9, &p, &life), life: None, life_events: Vec::new(), told: Vec::new() }
    }

    fn player(entity: EntityId, name: &str, bot: bool, x: f64, z: f64) -> ruina_wire::Record {
        let p = crate::player::Player::new(crate::world::Spawn { x, z, facing: 0.0 }, 0, crate::player::Build::default());
        pack::player(entity.raw(), wire_id(entity), name.into(), bot, &p, None, 0)
    }

    /// A tick with Ada (7) at the middle, Bo 150 m off, Cy out of sight, a bot beside her, an arrow
    /// near and one far, a slime and a table.
    fn a_tick() -> (TickOut, Private) {
        let me = private(7, 0.0, 0.0);
        let mut frame = Frame::new(77);
        frame.push(player(EntityId::character(7), "Ada", false, 0.0, 0.0));
        frame.push(player(EntityId::character(8), "Bo", false, 150.0, 0.0));
        frame.push(player(EntityId::character(9), "Cy", false, 500.0, 500.0));
        frame.push(player(EntityId::bot(1, 4), "Skirmisher 4", true, 3.0, 0.0));
        let mut f = [0; ruina_wire::schema::MAX_FIELDS];
        for (id, x) in [(1, 1000), (2, 20_000)] {
            f[0] = x;
            frame.push(ruina_wire::Record {
                key: pack::key(Kind::Arrow, id),
                owner: 0,
                intro: Intro::Arrow { id },
                fields: f,
                refers: EntityId::character(7).raw(),
            });
        }
        let mut slime = [0; ruina_wire::schema::MAX_FIELDS];
        slime[0] = 500;
        slime[8] = -1;
        frame.push(ruina_wire::Record { key: EntityId::creature(12).raw(), owner: 0, intro: Intro::Creature { id: 12 }, fields: slime, refers: 0 });
        let out = TickOut {
            sim: SimId(1),
            space: Some(SpaceId::channel("emberholm", 1)),
            tick: 77,
            frame,
            tables: vec![
                TableRecord { x: 20.0, z: 20.0, shown: serde_json::json!({ "board": 1 }) },
                TableRecord { x: 400.0, z: 0.0, shown: serde_json::json!({ "board": 2 }) },
            ],
            private: vec![me.clone()],
            ..TickOut::default()
        };
        (out, me)
    }

    #[test]
    fn a_tick_is_the_world_near_you_on_the_wire_and_your_own_in_json() {
        let (out, me) = a_tick();
        let mut enc = Encoder::new(7, false);
        let (bytes, text) = enc.tick(&out, &me, Owed::default());
        // The JSON: your own state, the table near you, and nobody else.
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!((v["t"].as_str(), v["tick"].as_u64()), (Some("tick"), Some(77)));
        assert_eq!((v["you"]["id"].as_u64(), v["you"]["ack"].as_u64()), (Some(3), Some(9)));
        assert_eq!(v["tables"].as_array().map(Vec::len), Some(1));
        assert_eq!(v["tables"][0]["board"], 1);
        for gone in ["peers", "actors", "arrows", "meteors", "events", "stats", "life", "lifeEvents"] {
            assert!(v.get(gone).is_none(), "{gone}");
        }
        // The update: the bot, Bo far off, the slime, and the arrow near (yours: handle 1); never Ada
        // herself, nor Cy, out of sight.
        let mut heard = Heard::new();
        heard.hear(&bytes).unwrap().expect("applied");
        let mut seen: Vec<(Kind, i64)> = heard
            .ents
            .values()
            .map(|e| match &e.intro {
                Intro::Player { id, .. } | Intro::Creature { id } | Intro::Arrow { id } => (e.kind(), *id),
                other => panic!("{other:?}"),
            })
            .collect();
        seen.sort();
        assert_eq!(seen, [(Kind::Player, crate::sim::FIRST_BOT - 4), (Kind::Player, 8), (Kind::Creature, 12), (Kind::Arrow, 1)]);
        let arrow = heard.ents.values().find(|e| e.kind() == Kind::Arrow).unwrap();
        assert_eq!(arrow.now().fields[6], 1, "your own arrow names you");
        // Your acknowledgement comes back and the next update is measured against it.
        assert!(enc.ack(&heard.ack().write()));
        assert!(!enc.ack(&[7, 1, 2]));
        let (again, _) = enc.tick(&out, &me, Owed::default());
        assert!(again.len() < bytes.len() / 2, "{} bytes after {}", again.len(), bytes.len());
    }

    #[test]
    fn what_a_slow_connection_missed_comes_with_the_next_and_an_admin_sees_what_a_tick_cost() {
        let (mut out, me) = a_tick();
        out.stats = Some(Stats { tick: 77, players: 1, ..Stats::default() });
        let mut owed = Owed::default();
        let mut missed = me.clone();
        missed.life_events = vec![ruina_engine::life::LifeEvent::Toast { text: "Sold".into(), kind: "info".into() }];
        missed.told = vec![Event::new(10, 20, 30, 4, 15)];
        owed.keep(&missed);
        let mut enc = Encoder::new(7, true);
        let (bytes, text) = enc.tick(&out, &me, owed);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["lifeEvents"][0]["text"], "Sold");
        assert_eq!(v["stats"]["wire"].as_u64(), Some(bytes.len() as u64));
        let mut heard = Heard::new();
        let done = heard.hear(&bytes).unwrap().unwrap();
        assert_eq!(done.events, [[10, 30, 20, 4, 15]], "the hit you were told of");
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
