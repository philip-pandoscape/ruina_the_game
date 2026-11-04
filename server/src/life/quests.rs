//! The starter questline (src/sim/life/quests.ts).
//! STUB: the signatures are fixed (other modules call them); the bodies are being ported.
#![allow(unused_variables)]

use super::content::QuestDef;
use super::{Life, QuestEvent};
use crate::open::Sim;

pub fn quest_done(life: &Life, id: &str) -> bool {
    life.state.quests.done.iter().any(|d| d == id)
}

/// Index of the quest in life.state.quests.active, if it is active.
pub fn quest_active(life: &Life, id: &str) -> Option<usize> {
    life.state.quests.active.iter().position(|q| q.id == id)
}

/// Offered and not yet taken.
pub fn available(life: &Life, q: &QuestDef) -> bool {
    unimplemented!()
}

pub fn is_ready(life: &Life, id: &str) -> bool {
    unimplemented!()
}

/// Quests this NPC has to give, and quests ready to hand in to them: (offer, turn_in).
pub fn quests_at(life: &Life, npc: &str) -> (Vec<&'static QuestDef>, Vec<&'static QuestDef>) {
    unimplemented!()
}

pub fn start_quests(life: &mut Life) {}

pub fn accept(life: &mut Life, id: &str) -> bool {
    unimplemented!()
}

pub fn complete(life: &mut Life, id: &str) -> bool {
    unimplemented!()
}

pub fn notify_quests(life: &mut Life, e: &QuestEvent) {}

pub fn step_quests(life: &mut Life, sim: &mut Sim) {}
