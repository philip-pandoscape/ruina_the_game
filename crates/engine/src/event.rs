//! What happened in a step, for whoever shows it: the browser's effects, sounds and numbers, and
//! the experience a skill gains (src/sim/types.ts GameEvent: the same kinds and fields, written as
//! the browser reads them). The rules raise them where things happen (a jump, a swing landing); the
//! browser's session (crate::session) takes each step's and hands them over with the step's frame.
//! The server, which tells its browsers what happened in its own words (crates/server/src/combat.rs),
//! leaves them.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    Jump {
        x: f64,
        y: f64,
        z: f64,
    },
    DoubleJump {
        x: f64,
        y: f64,
        z: f64,
    },
    Land {
        x: f64,
        y: f64,
        z: f64,
        impact: f64,
    },
    /// A movement skill started: `id` indexes the movement skills.
    Action {
        id: u8,
        x: f64,
        y: f64,
        z: f64,
    },
    Attack {
        index: usize,
    },
    /// A blow landed; `weapon` is what dealt it (a swing, or the bow that loosed the arrow), none for a blast.
    Hit {
        index: usize,
        damage: f64,
        x: f64,
        y: f64,
        z: f64,
        dir_x: f64,
        dir_z: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        weapon: Option<u8>,
    },
    /// Anything in the world died; `killed`: a blow finished it off, rather than a piece dissolving.
    ActorDie {
        id: u32,
        kind: String,
        x: f64,
        y: f64,
        z: f64,
        killed: bool,
    },
    ActorBurst {
        kind: String,
        count: u32,
        x: f64,
        y: f64,
        z: f64,
    },
    ActorCall {
        id: u32,
        x: f64,
        y: f64,
        z: f64,
        radius: f64,
    },
    GatherStart {
        id: u32,
        x: f64,
        y: f64,
        z: f64,
        radius: f64,
    },
    GatherBroken {
        id: u32,
        x: f64,
        y: f64,
        z: f64,
    },
    ActorAbsorbed {
        x: f64,
        y: f64,
        z: f64,
        to_x: f64,
        to_z: f64,
    },
    ActorGrow {
        id: u32,
        kind: String,
        x: f64,
        y: f64,
        z: f64,
    },
    /// A monster's slam landed.
    Slam {
        x: f64,
        y: f64,
        z: f64,
        radius: f64,
    },
    /// It caught you.
    Hurt {
        damage: f64,
        x: f64,
        y: f64,
        z: f64,
    },
    MissileLand {
        x: f64,
        y: f64,
        z: f64,
    },
    ActorHeal {
        id: u32,
        x: f64,
        y: f64,
        z: f64,
        amount: f64,
    },
    Respawn {
        x: f64,
        y: f64,
        z: f64,
    },
    /// A movement or hotbar slot was pressed without the stamina or MP its skill costs.
    Short {
        what: &'static str,
    },
    /// A bow loosed an arrow.
    Shoot {
        x: f64,
        y: f64,
        z: f64,
        dir_x: f64,
        dir_z: f64,
        speed: f64,
        range: f64,
        damage: f64,
        pierce: u32,
        weapon: u8,
    },
    /// A cast finished: `ability` at (x, z), cast from (caster_x, caster_z).
    Cast {
        ability: u8,
        x: f64,
        z: f64,
        caster_x: f64,
        caster_z: f64,
    },
    Heal {
        x: f64,
        y: f64,
        z: f64,
        radius: f64,
    },
    Explosion {
        x: f64,
        y: f64,
        z: f64,
        radius: f64,
    },
    ArrowHit {
        x: f64,
        y: f64,
        z: f64,
    },
    GlideOpen {
        x: f64,
        y: f64,
        z: f64,
    },
    GlideClose {
        x: f64,
        y: f64,
        z: f64,
    },
    Splash {
        x: f64,
        y: f64,
        z: f64,
        speed: f64,
    },
}
