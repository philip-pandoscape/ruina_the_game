//! How a channel steps its players each tick: one after another, or all at once on the machine's
//! cores. Each player's step reads everyone else only as they stood when the tick began, and what
//! it does to them is applied once everyone has stepped (crates/engine/src/combat.rs), so the two
//! play the same game, bit for bit (the tests in play/bots.rs). The engine has no threads of its
//! own: it hands the server its players' steps as jobs, and the server runs them.

use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;
use ruina_engine::combat::Job;

#[cfg(test)]
use crate::rng::Rng;

/// Whether channels made from now on step their players all at once (`--parallel on`).
static PARALLEL: AtomicBool = AtomicBool::new(false);

/// Steps every channel made from now on all at once (true) or one player after another.
pub fn set_parallel(on: bool) {
    PARALLEL.store(on, Ordering::Relaxed);
}

pub enum Stepping {
    /// One after another, in the order of their slots.
    InOrder,
    /// All at once, spread over the machine's cores.
    Parallel,
    /// One after another, in an order shuffled afresh every tick: what the tests step a channel
    /// with to show that the order makes no difference.
    #[cfg(test)]
    Shuffled(Rng),
}

impl Stepping {
    /// What a new channel does, as the server was started.
    pub fn chosen() -> Stepping {
        if PARALLEL.load(Ordering::Relaxed) { Stepping::Parallel } else { Stepping::InOrder }
    }

    /// Runs every player's step of a tick, as this says.
    pub fn run(&mut self, jobs: &mut [Job], step: &(dyn Fn(&mut Job) + Sync)) {
        match self {
            Stepping::InOrder => jobs.iter_mut().for_each(step),
            Stepping::Parallel => jobs.par_iter_mut().for_each(step),
            #[cfg(test)]
            Stepping::Shuffled(rng) => {
                // Left in that order, too: what comes of them mustn't hang on it either.
                rng.shuffle(jobs);
                jobs.iter_mut().for_each(step);
            }
        }
    }
}
