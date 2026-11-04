//! What pressing F does right now, and the commands everything else sends
//! (src/sim/life/interact.ts). Being ported: see the module list in life/mod.rs.

use super::{Command, Life};
use crate::open::Sim;

pub fn run_command(_life: &mut Life, _sim: &mut Sim, _c: &Command) {}

/// Every step: resting ends as soon as you move.
pub fn keep_resting(_life: &mut Life, _sim: &mut Sim) {}
