//! The golden fixtures the browser's decoder is held to (tests/unit/wire.test.ts): the schema, and
//! updates as this crate's Viewer writes them in a few scenes, each with what this crate's Heard
//! makes of it, step by step: what applying it did, the acknowledgement to send, and everything in
//! sight after. The browser's src/net/wire must come to the same, byte for byte and field for field.
//!
//! The fixtures are kept in tests/fixtures/wire/. When the protocol changes on purpose, write them
//! again (RUINA_GOLDEN=1 cargo test -p ruina-wire --test golden) and bring src/net/wire with it.

mod common;

use std::fmt::Write as _;

use common::World;
use ruina_wire::heard::{Applied, Heard};
use ruina_wire::pack::{key, owned_key};
use ruina_wire::record::{Event, Frame, Intro, Record};
use ruina_wire::schema::{EVENT, Kind, MAX_FIELDS, MODES, Run, Tier};
use ruina_wire::viewer::{View, Viewer, WINDOW};
use serde_json::{Value, json};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/wire");

fn tier_name(t: Tier) -> &'static str {
    match t {
        Tier::Near => "near",
        Tier::Mid => "mid",
        Tier::Far => "far",
    }
}

fn run_json(r: Run) -> Value {
    match r {
        Run::Still => json!({ "still": true }),
        Run::Up { per, cap } => json!({ "up": per, "cap": cap }),
        Run::Down { per } => json!({ "down": per }),
    }
}

fn schema() -> Value {
    let kinds: serde_json::Map<String, Value> = Kind::ALL
        .iter()
        .map(|k| {
            let fields: Vec<Value> = k.fields().iter().map(|f| json!({ "name": f.name, "tier": tier_name(f.tier), "run": run_json(f.run) })).collect();
            (k.name().to_string(), json!({ "byte": *k as u8, "fields": fields, "reference": ruina_wire::schema::reference(*k) }))
        })
        .collect();
    let event: Vec<&str> = EVENT.iter().map(|f| f.name).collect();
    json!({ "update": ruina_wire::viewer::UPDATE, "ack": ruina_wire::ack::ACK, "window": WINDOW, "maxFields": MAX_FIELDS, "modes": MODES, "kinds": kinds, "event": event })
}

fn intro_json(i: &Intro) -> Value {
    match i {
        Intro::Player { id, name, bot } => json!({ "id": id, "name": &**name, "bot": bot }),
        Intro::Creature { id } | Intro::Arrow { id } | Intro::Meteor { id } => json!({ "id": id }),
        Intro::Vehicle { owner, id, def } | Intro::Item { owner, id, def } => json!({ "owner": owner, "id": id, "def": def }),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// A Viewer and a Heard, every update and what came of it written down.
struct Scene {
    viewer: Viewer,
    heard: Heard,
    steps: Vec<Value>,
}

impl Scene {
    fn new(me: u64) -> Scene {
        Scene { viewer: Viewer::new(me), heard: Heard::new(), steps: Vec::new() }
    }

    fn write(&mut self, frame: &Frame, view: View, told: &[Event]) -> Vec<u8> {
        self.viewer.update(frame, view, told)
    }

    /// The update arrives, and is heard.
    fn arrive(&mut self, bytes: &[u8]) {
        let done = self.heard.hear(bytes).expect("an update reads");
        let heard = done.map(|d: Applied| {
            json!({ "seq": d.seq, "tick": d.tick, "removed": d.removed, "introduced": d.introduced, "fresh": d.fresh, "whole": d.whole, "events": d.events })
        });
        let mut sight: Vec<(u16, Value)> = self
            .heard
            .ents
            .iter()
            .map(|(h, e)| {
                let s = e.now();
                let n = e.kind().fields().len();
                (*h, json!({ "handle": h, "kind": e.kind().name(), "intro": intro_json(&e.intro), "tier": tier_name(e.tier), "seq": s.seq, "tick": s.tick, "fields": &s.fields[..n] }))
            })
            .collect();
        sight.sort_by_key(|(h, _)| *h);
        let a = self.heard.ack();
        self.steps.push(json!({
            "bytes": hex(bytes),
            "deliver": true,
            "heard": heard,
            "ack": { "seq": a.seq, "bits": a.bits },
            "sight": sight.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        }));
    }

    /// The update is lost on the way.
    fn lose(&mut self, bytes: &[u8]) {
        self.steps.push(json!({ "bytes": hex(bytes), "deliver": false }));
    }

    /// The Heard's acknowledgement reaches the Viewer.
    fn ack(&mut self) {
        self.viewer.ack(&self.heard.ack());
    }
}

fn player(id: i64, name: &str, x: i32, z: i32) -> Record {
    let mut f = [0; MAX_FIELDS];
    let at = |n: &str| ruina_wire::schema::PLAYER.iter().position(|x| x.name == n).expect("a field");
    f[0] = x;
    f[1] = z;
    f[2] = 250;
    f[3] = 12_000;
    for n in ["attackFrame", "castFrame", "actionFrame", "flipFrame", "downFrame"] {
        f[at(n)] = -1;
    }
    f[at("landFrame")] = 999;
    f[at("takeoffFrame")] = 999;
    f[at("castAbility")] = 255;
    f[at("actionId")] = 255;
    f[at("hp")] = 10_000;
    f[at("flags")] = 1;
    let k = key(Kind::Player, id);
    Record { key: k, owner: k, intro: Intro::Player { id, name: name.into(), bot: id < 0 }, fields: f, refers: 0 }
}

/// A few of everything near you, moving, swinging, shooting, then a quiet road: first sight, deltas
/// against what was acknowledged, counters running on, references as handles, effects.
fn everything() -> Value {
    let me = key(Kind::Player, 1);
    let mut scene = Scene::new(me);
    let view = View { x: 0.0, z: 0.0 };
    for t in 0..8u64 {
        let mut frame = Frame::new(529_000_000 + t);
        let step = t as i32;
        frame.push(player(1, "You", 0, 0));
        let mut ada = player(7, "Ada", 500 + step * 30, -200);
        let at = |n: &str| ruina_wire::schema::PLAYER.iter().position(|x| x.name == n).expect("a field");
        if t >= 2 {
            ada.fields[at("mode")] = 1;
            ada.fields[at("attackFrame")] = (step - 2) * 3;
        }
        ada.fields[at("run")] = step * 30;
        frame.push(ada);
        let mut bot = player(-1_000_002, "Skirmisher 2", -900, 1200);
        if t >= 5 {
            bot.fields[at("hp")] = 9_250;
            // Riding along with you.
            bot.fields[at("mode")] = 6;
            bot.fields[at("seat")] = 1;
            bot.refers = me;
        }
        frame.push(bot);
        let mut slime = [0; MAX_FIELDS];
        slime[0] = 300;
        slime[1] = 900 - step * 10;
        slime[3] = 40_000;
        slime[5] = step * 3;
        slime[6] = 60;
        slime[7] = 10_000;
        slime[8] = -1;
        slime[11] = 2;
        frame.push(Record { key: key(Kind::Creature, 12), owner: 0, intro: Intro::Creature { id: 12 }, fields: slime, refers: 0 });
        let mut cart = [0; MAX_FIELDS];
        cart[0] = 800;
        cart[1] = -200;
        cart[3] = 16_384;
        cart[10] = 1;
        cart[11] = 4;
        frame.push(Record {
            key: owned_key(Kind::Vehicle, 7, 3),
            owner: key(Kind::Player, 7),
            intro: Intro::Vehicle { owner: 7, id: 3, def: 0 },
            fields: cart,
            refers: 0,
        });
        let mut crate_ = [0; MAX_FIELDS];
        crate_[0] = -400;
        crate_[1] = -400;
        crate_[2] = 10;
        crate_[3] = 32_768;
        frame.push(Record {
            key: owned_key(Kind::Item, 7, 9),
            owner: key(Kind::Player, 7),
            intro: Intro::Item { owner: 7, id: 9, def: 5 },
            fields: crate_,
            refers: 0,
        });
        if (3..6).contains(&t) {
            // Your arrow and Ada's.
            for (id, owner, x) in [(40, me, 100), (41, key(Kind::Player, 7), 700)] {
                let mut a = [0; MAX_FIELDS];
                a[0] = x + (step - 3) * 150;
                a[1] = 0;
                a[2] = 130;
                a[3] = 3000;
                frame.push(Record { key: key(Kind::Arrow, id), owner, intro: Intro::Arrow { id }, fields: a, refers: owner });
            }
        }
        if t == 4 {
            let mut m = [0; MAX_FIELDS];
            m[0] = -600;
            m[1] = 600;
            m[2] = 20;
            m[3] = 20;
            m[4] = 1;
            m[5] = 400;
            frame.push(Record { key: key(Kind::Meteor, 3), owner: 0, intro: Intro::Meteor { id: 3 }, fields: m, refers: 0 });
            frame.event(Event::new(700, 130, 0, 3, 12));
        }
        let told = if t == 6 { vec![Event::new(500, 140, -200, 4 | (1 << 4) | (2 << 6), 15)] } else { Vec::new() };
        let bytes = scene.write(&frame, view, &told);
        scene.arrive(&bytes);
        scene.ack();
    }
    json!({ "name": "a few of everything near you", "steps": scene.steps })
}

/// A busier world over a bad road: updates lost and arriving late (stale), acknowledgements held
/// back, introductions said again until acknowledged.
fn bad_road() -> Value {
    let mut world = World::new(19, 8, 6, 70.0);
    let mut scene = Scene::new(0);
    let view = View { x: 0.0, z: 0.0 };
    let mut held: Option<Vec<u8>> = None;
    for t in 0..24u64 {
        world.step();
        let bytes = scene.write(&world.frame(), view, &[]);
        match t % 6 {
            // Lost.
            1 => scene.lose(&bytes),
            // Held back: overtaken by the next.
            3 => held = Some(bytes),
            4 => {
                scene.arrive(&bytes);
                if let Some(late) = held.take() {
                    scene.arrive(&late);
                }
            }
            _ => scene.arrive(&bytes),
        }
        // Acknowledgements only every third tick.
        if t % 3 == 2 {
            scene.ack();
        }
    }
    json!({ "name": "a bad road", "steps": scene.steps })
}

/// Everything leaves sight and comes back: removals, then handles given again.
fn out_and_back() -> Value {
    let mut world = World::new(29, 6, 4, 40.0);
    let mut scene = Scene::new(0);
    for t in 0..16u64 {
        world.step();
        let view = if (t / 4) % 2 == 0 { View { x: 0.0, z: 0.0 } } else { View { x: 500.0, z: 0.0 } };
        let bytes = scene.write(&world.frame(), view, &[]);
        scene.arrive(&bytes);
        scene.ack();
    }
    json!({ "name": "out of sight and back", "steps": scene.steps })
}

/// Some near, some at the middle distance, some far: each refreshed at its tier's rate, with the
/// fields its tier refreshes.
fn tiers() -> Value {
    let mut world = World::new(37, 12, 0, 1.0);
    world.things.retain(|t| t.intro.kind() == Kind::Player);
    for (k, t) in world.things.iter_mut().enumerate() {
        // 10 m, 70 m and 180 m out, by turns.
        let d = [10.0, 70.0, 180.0][k % 3];
        let a = k as f64;
        t.fields[0] = (a.cos() * d * 100.0) as i32;
        t.fields[1] = (a.sin() * d * 100.0) as i32;
        t.vx = 0.1;
    }
    world.busy = 1.0;
    let mut scene = Scene::new(0);
    for _ in 0..26u64 {
        world.step();
        let bytes = scene.write(&world.frame(), View { x: 0.0, z: 0.0 }, &[]);
        scene.arrive(&bytes);
        scene.ack();
    }
    json!({ "name": "near, middle and far", "steps": scene.steps })
}

/// Writes a fixture (`pretty`: a field a line, for the schema a person reads; else a scene a line).
fn check_or_keep(name: &str, value: &Value, pretty: bool) {
    let path = format!("{DIR}/{name}");
    let text = if pretty {
        serde_json::to_string_pretty(value).expect("json") + "\n"
    } else {
        // A scene a line, so a change to one shows as one line changed.
        let scenes = value["scenes"].as_array().expect("scenes");
        let lines: Vec<String> = scenes.iter().map(|s| serde_json::to_string(s).expect("json")).collect();
        format!("{{\"scenes\": [\n{}\n]}}\n", lines.join(",\n"))
    };
    if std::env::var_os("RUINA_GOLDEN").is_some() {
        std::fs::create_dir_all(DIR).expect("the fixtures' folder");
        std::fs::write(&path, &text).expect("written");
        return;
    }
    let kept = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        kept == text,
        "{name} isn't what the wire writes now: if the protocol changed on purpose, write the fixtures again \
         (RUINA_GOLDEN=1 cargo test -p ruina-wire --test golden) and bring src/net/wire with it"
    );
}

#[test]
fn the_fixtures_are_what_the_wire_writes() {
    check_or_keep("schema.json", &schema(), true);
    check_or_keep("updates.json", &json!({ "scenes": [everything(), bad_road(), out_and_back(), tiers()] }), false);
}
