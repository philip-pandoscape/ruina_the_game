//! The browser's game (ruina_engine::session) through the plain interface: a page (or a test) makes
//! a session, steps it once per fixed frame with what was pressed, and reads back you, the
//! creatures, the island and what happened, as JSON in the shapes src/engine/ reads. Everything else the
//! Engine does from outside the rules is one named call (`session_call`), so the interface stays
//! small while what crosses it each frame stays cheap.

use std::cell::RefCell;

use std::collections::BTreeMap;

use ruina_engine::life::state::{House, LifeState, Scarecrow};
use ruina_engine::life::{Command, OtherPlayer, OthersVehicle, Placement};
use ruina_engine::open::Mover;
use ruina_engine::player::{Actions, Build};
use ruina_engine::session::Session;
use ruina_engine::skills::SKILL_WORDS;
use ruina_engine::tuning::{HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT};
use ruina_engine::world::Spawn;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{give, text};

thread_local! {
    /// The sessions made, by handle less one; a freed one leaves a gap.
    static SESSIONS: RefCell<Vec<Option<Session>>> = const { RefCell::new(Vec::new()) };
}

fn with<T>(h: u32, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
    SESSIONS.with(|s| s.borrow_mut().get_mut((h as usize).wrapping_sub(1)).and_then(Option::as_mut).map(f))
}

/// A build as the browser keeps one (src/content/build.ts Build), taken as it is: the page checks
/// builds itself, and the server checks them again online.
pub fn build_of(v: &Value) -> Option<Build> {
    let mut b = Build { weapon: u8::try_from(v.get("weapon")?.as_u64()?).ok()?, ..Build::default() };
    let mut skills = [0u32; SKILL_WORDS];
    for (k, w) in v.get("skills")?.as_array()?.iter().take(SKILL_WORDS).enumerate() {
        skills[k] = u32::try_from(w.as_u64()?).ok()?;
    }
    b.skills = skills;
    let slots = |key: &str, out: &mut [u8], empty: u8| {
        out.fill(empty);
        for (k, a) in v.get(key).and_then(Value::as_array).into_iter().flatten().take(out.len()).enumerate() {
            out[k] = a.as_u64().and_then(|n| u8::try_from(n).ok()).unwrap_or(empty);
        }
    };
    let mut abilities = [NO_ABILITY; HOTBAR_SLOTS];
    let mut movement = [NO_MOVEMENT; MOVEMENT_SLOTS];
    slots("abilities", &mut abilities, NO_ABILITY);
    slots("movement", &mut movement, NO_MOVEMENT);
    b.abilities = abilities;
    b.movement = movement;
    Some(b)
}

/// A new session from its options (JSON: `online`, `build`): its handle, or 0 if they can't be read.
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn session_new(p: *const u8, n: usize) -> u32 {
    let Ok(o) = serde_json::from_str::<Value>(unsafe { text(p, n) }) else { return 0 };
    let Some(build) = o.get("build").and_then(build_of) else { return 0 };
    let online = o.get("online").and_then(Value::as_bool).unwrap_or(false);
    let s = Session::new(online, build);
    SESSIONS.with(|list| {
        let mut list = list.borrow_mut();
        list.push(Some(s));
        list.len() as u32
    })
}

/// Lets a session go.
#[unsafe(no_mangle)]
pub extern "C" fn session_free(h: u32) {
    SESSIONS.with(|s| {
        if let Some(slot) = s.borrow_mut().get_mut((h as usize).wrapping_sub(1)) {
            *slot = None;
        }
    });
}

/// One fixed step with what was pressed (src/engine/shapes.ts Actions). `flags`: jump pressed 1, jump
/// held 2, attack pressed 4, slide pressed 8, sprint held 16, crouch held 32. Returns how many
/// events are waiting.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn session_step(
    h: u32,
    move_x: f64,
    move_z: f64,
    flags: u32,
    ability_slot: u32,
    movement_slot: u32,
    movement_held: u32,
    aim_x: f64,
    aim_z: f64,
    face_x: f64,
    face_z: f64,
    stick_x: f64,
    stick_y: f64,
) -> usize {
    let a = Actions {
        move_x,
        move_z,
        jump_pressed: flags & 1 != 0,
        jump_held: flags & 2 != 0,
        attack_pressed: flags & 4 != 0,
        slide_pressed: flags & 8 != 0,
        sprint_held: flags & 16 != 0,
        crouch_held: flags & 32 != 0,
        ability_slot: ability_slot as u8,
        movement_slot: movement_slot as u8,
        movement_held: movement_held as u8,
        aim_x,
        aim_z,
        face_x,
        face_z,
        stick_x,
        stick_y,
    };
    with(h, |s| {
        s.step(&a);
        s.events.len()
    })
    .unwrap_or(0)
}

/// Online, the world's clock (the server's, in seconds since 1970) the rain and the wind run on,
/// for the next step; NaN for none (offline, the island's own clock).
#[unsafe(no_mangle)]
pub extern "C" fn session_world_clock(h: u32, t: f64) {
    with(h, |s| s.set_world_clock(if t.is_nan() { None } else { Some(t) }));
}

/// Your island as a tick has it (src/net/worldLink.ts WorldTick.life: JSON `{state, placing,
/// resting}`), read straight from the text: it comes up to 20 times a second. True if it could be read.
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn session_take_island(h: u32, p: *const u8, n: usize) -> u32 {
    #[derive(Deserialize)]
    struct Sent {
        state: LifeState,
        #[serde(default)]
        placing: Option<Placement>,
        #[serde(default)]
        resting: bool,
    }
    let Ok(sent) = serde_json::from_str::<Sent>(unsafe { text(p, n) }) else { return 0 };
    with(h, |s| s.take_island(sent.state, sent.placing, sent.resting)).is_some() as u32
}

/// Everything the page reads after a step (`events` 1: with what happened, taken) or a call (0),
/// as JSON (Session::view_text).
#[unsafe(no_mangle)]
pub extern "C" fn session_view(h: u32, events: u32) -> usize {
    give(with(h, |s| s.view_text(events != 0)).unwrap_or_default())
}

/// A number that changes whenever what's solid on the island changes (Session::solid_key).
#[unsafe(no_mangle)]
pub extern "C" fn session_solid_key(h: u32) -> u32 {
    with(h, |s| s.solid_key()).unwrap_or(0)
}

/// Everything solid on the island as it stands (JSON `{obstacles, boxes, decks}`).
#[unsafe(no_mangle)]
pub extern "C" fn session_colliders(h: u32) -> usize {
    give(with(h, |s| s.colliders_json().to_string()).unwrap_or_default())
}

/// The island's cells kept clear of trees and scarecrows, where they lie (`session_clear_len` of them).
#[unsafe(no_mangle)]
pub extern "C" fn session_clear_ptr(h: u32) -> *const u8 {
    with(h, |s| s.clear().as_ptr()).unwrap_or(std::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn session_clear_len(h: u32) -> usize {
    with(h, |s| s.clear().len()).unwrap_or(0)
}

/// What you press in a step, in the shape of src/engine/shapes.ts Actions.
fn actions_of(v: &Value) -> Actions {
    let f = |k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let b = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    let u = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0) as u8;
    Actions {
        move_x: f("moveX"),
        move_z: f("moveZ"),
        jump_pressed: b("jumpPressed"),
        jump_held: b("jumpHeld"),
        attack_pressed: b("attackPressed"),
        slide_pressed: b("slidePressed"),
        sprint_held: b("sprintHeld"),
        crouch_held: b("crouchHeld"),
        ability_slot: u("abilitySlot"),
        movement_slot: u("movementSlot"),
        movement_held: u("movementHeld"),
        aim_x: f("aimX"),
        aim_z: f("aimZ"),
        face_x: f("faceX"),
        face_z: f("faceZ"),
        stick_x: f("stickX"),
        stick_y: f("stickY"),
    }
}

/// A value of the call's, read as `T` (None if it's missing or isn't one).
fn field<T: for<'de> Deserialize<'de>>(v: &Value, k: &str) -> Option<T> {
    v.get(k).filter(|x| !x.is_null()).and_then(|x| T::deserialize(x).ok())
}

/// Takes what happened since the last time: JSON, each event as src/engine/shapes.ts GameEvent has it.
#[unsafe(no_mangle)]
pub extern "C" fn session_events(h: u32) -> usize {
    let list = with(h, |s| {
        s.take_events()
            .into_iter()
            .map(|(frame, e)| {
                let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
                if let Value::Object(m) = &mut v {
                    m.insert("frame".into(), json!(frame));
                }
                v
            })
            .collect::<Vec<_>>()
    });
    give(serde_json::to_string(&list.unwrap_or_default()).unwrap_or_default())
}

/// You, as src/engine/shapes.ts PlayerState has you (JSON).
#[unsafe(no_mangle)]
pub extern "C" fn session_player(h: u32) -> usize {
    give(with(h, |s| s.player_json().to_string()).unwrap_or_default())
}

/// The creatures and what they've thrown (JSON `{list, missiles}`).
#[unsafe(no_mangle)]
pub extern "C" fn session_actors(h: u32) -> usize {
    give(with(h, |s| s.actors_json().to_string()).unwrap_or_default())
}

/// The island as the page shows it (JSON `{state, focus, placing, resting, revision}`).
#[unsafe(no_mangle)]
pub extern "C" fn session_life(h: u32) -> usize {
    give(with(h, |s| s.life_json().to_string()).unwrap_or_default())
}

/// One of the Engine's other calls, named in `call` with its arguments beside it (JSON); the
/// answer is JSON too (null for none).
///
/// # Safety
/// `p..p + n` lies in room `alloc` gave.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn session_call(h: u32, p: *const u8, n: usize) -> usize {
    let v = serde_json::from_str::<Value>(unsafe { text(p, n) }).unwrap_or(Value::Null);
    let answer = with(h, |s| call(s, &v)).unwrap_or(Value::Null);
    give(answer.to_string())
}

fn call(s: &mut Session, v: &Value) -> Value {
    let num = |k: &str| v.get(k).and_then(Value::as_f64);
    let n = |k: &str| num(k).unwrap_or(0.0);
    let str_of = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    match v.get("call").and_then(Value::as_str).unwrap_or("") {
        "place" => s.place(n("x"), n("z"), n("facing"), num("fromY")),
        "setBuild" => {
            if let Some(b) = v.get("build").and_then(build_of) {
                s.set_build(b);
            }
        }
        "setLevels" => {
            let levels: Vec<u32> = v.get("levels").and_then(Value::as_array).into_iter().flatten().map(|l| l.as_u64().unwrap_or(1) as u32).collect();
            s.set_levels(&levels);
        }
        "command" => match v.get("command").cloned().map(serde_json::from_value::<Command>) {
            Some(Ok(c)) => s.command(c),
            Some(Err(e)) => return json!({ "error": e.to_string() }),
            None => {}
        },
        "enterDungeon" => return json!(s.enter_dungeon(str_of("id"))),
        "leaveDungeon" => s.leave_dungeon(),
        "inside" => return json!(s.inside()),
        "floorAt" => return json!(s.floor_at(n("x"), n("z"))),
        "floorHere" => return json!(s.floor_here()),
        "solidity" => return json!(s.solidity()),
        "spaceGround" => return s.space_ground(),
        "groundY" => return json!(s.ground_y(n("x"), n("z"))),
        "standingAt" => return json!(s.standing_at(n("x"), n("z"), n("near"), n("pad"))),
        "loadIsland" => return json!(v.get("data").is_some_and(|d| s.load_island(d, n("now")))),
        "reset" => {
            let at = &v["at"];
            let f = |k: &str| at.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            if let Some(b) = v.get("build").and_then(build_of) {
                s.reset(Spawn { x: f("x"), z: f("z"), facing: f("facing") }, b);
            }
        }
        "setVitals" => s.set_vitals(num("stamina"), num("mp")),
        "calm" => s.calm(v.get("on").and_then(Value::as_bool).unwrap_or(false)),
        "placeActor" => s.place_actor(str_of("kind"), n("i") as usize, n("x"), n("z")),
        "setActor" => {
            let empty = Map::new();
            let fields = v.get("fields").and_then(Value::as_object).unwrap_or(&empty);
            return json!(s.set_actor(n("id") as u32, fields));
        }
        "spawnActor" => return json!(s.spawn_actor(str_of("kind"), n("x"), n("z"))),
        "spawnBand" => return json!(s.spawn_band(str_of("kind"), n("count") as usize, n("x"), n("z"))),
        "hurtActor" => s.hurt_actor(n("id") as u32, n("amount")),
        "takeHit" => s.take_hit(n("damage"), n("dirX"), n("dirZ"), n("knock")),
        "frame" => return json!(s.frame),
        "placed" => return json!(s.placed),
        "lifeEvents" => return json!(s.life.as_mut().map(|l| l.drain_events()).unwrap_or_default()),
        "takePlayer" => s.take_player(&v["player"]),
        "replay" => {
            let inputs: Vec<Actions> = v.get("inputs").and_then(Value::as_array).into_iter().flatten().map(actions_of).collect();
            s.replay(&inputs, num("worldClock"));
        }
        "runAhead" => match field::<Command>(v, "command") {
            Some(c) => s.run_ahead(&c),
            None => return json!({ "error": "runAhead: no command" }),
        },
        "replayIsland" => {
            let you = &v["you"];
            let f = |k: &str| you.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            let ahead: Vec<Command> = field(v, "ahead").unwrap_or_default();
            s.replay_island(
                f("clock"),
                f("labor"),
                field(you, "weather").unwrap_or_default(),
                field(you, "vehicles").unwrap_or_default(),
                you.get("resting").and_then(Value::as_bool).unwrap_or(false),
                field(you, "placing"),
                &ahead,
            );
        }
        "addSolidHouse" => match field::<House>(v, "house") {
            Some(h) => s.add_solid_house(&h),
            None => return json!({ "error": "addSolidHouse: no house" }),
        },
        "addSolidScarecrow" => match field::<Scarecrow>(v, "post") {
            Some(sc) => s.add_solid_scarecrow(&sc),
            None => return json!({ "error": "addSolidScarecrow: no post" }),
        },
        "movers" => {
            // Others' vehicles: never yours (the session's player is owner 0).
            let movers = v.get("movers").and_then(Value::as_array).into_iter().flatten().map(|m| {
                let g = |k: &str| m.get(k).and_then(Value::as_f64).unwrap_or(0.0);
                Mover { owner: -1, x: g("x"), z: g("z"), r: g("r"), y: g("y"), height: g("height") }
            });
            s.set_movers(movers.collect());
        }
        "others" => {
            s.set_others(field::<Vec<OthersVehicle>>(v, "vehicles"), field::<Vec<OtherPlayer>>(v, "around"), field::<BTreeMap<String, String>>(v, "plots"))
        }
        other => return json!({ "error": format!("no call {other}") }),
    }
    Value::Null
}
