//! The world on several processes (`docs/architecture.md`, Several Processes). `ruina-server` plays
//! every tier in one process by default (`--role all`, as Railway's beta does), or one role per
//! process, each with the tiers its role names:
//!
//! - **services**: the store, social and the directory. The directory's leases are Postgres's
//!   (`pg.rs`), it places each simulation on the sim process with the least to play (the instance
//!   pool: region channels and instance copies alike), and every life written is fenced by its
//!   writer's lease as well as by the character's epoch.
//! - **gate**: players' connections, the account API and the game's files.
//! - **sim**: the simulations the directory starts here, each renewing its own lease (`keeper.rs`)
//!   and stopping when it's lost.
//!
//! Processes find each other through the directory's tables in Postgres (`nodes`: every process,
//! its role, where its links take messages and a gate's id; `space_leases`: which simulation plays
//! each space, in which process, under which epoch) and send each other the tiers' messages over
//! links (`crates/link`; `process.rs`: the post's way to the rest of the world, and what arrives).
//!
//! - `leases.rs`: grants, renewals, owners, the fence every write passes, snapshots.
//! - `keeper.rs`: a simulation's lease keeper, stopping it before its lease runs out.
//! - `nodes.rs`: the processes, their heartbeats and their sweep.
//! - `pg.rs`: the directory's leases in Postgres, placement, starting simulations in other processes.
//! - `process.rs`: one process among several: its links, the book of who takes which address, what
//!   arrives, the simulations it hosts.
//! - `roles.rs`: each role started, and its status page (`/api/cluster`).
//! - `wire.rs`: what the links carry.

pub mod keeper;
pub mod leases;
pub mod nodes;
pub mod pg;
pub mod process;
pub mod roles;
pub mod wire;

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// What a process plays.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Everything in one process: the default, and the server as it has always run.
    #[default]
    All,
    Gate,
    Sim,
    Services,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::All => "all",
            Role::Gate => "gate",
            Role::Sim => "sim",
            Role::Services => "services",
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl FromStr for Role {
    type Err = String;

    fn from_str(s: &str) -> Result<Role, String> {
        match s {
            "all" => Ok(Role::All),
            "gate" => Ok(Role::Gate),
            "sim" => Ok(Role::Sim),
            "services" => Ok(Role::Services),
            _ => Err(format!("--role takes all, gate, sim or services, not {s:?}")),
        }
    }
}

/// A process as it says it is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub node: String,
    pub role: Role,
    pub incarnation: u64,
    /// The simulations it plays (a sim's process), or has played since it started.
    pub sims: Vec<Playing>,
    /// Messages its links delivered, and those that came again and were dropped.
    pub delivered: u64,
    pub duplicates: u64,
}

/// A simulation a process plays, or played.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playing {
    pub space: String,
    pub sim: u64,
    pub epoch: u64,
    /// Whether it plays it now.
    pub holding: bool,
    /// Why it stopped.
    pub why: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_role_is_named_as_it_is_asked_for() {
        for role in [Role::All, Role::Gate, Role::Sim, Role::Services] {
            assert_eq!(role.name().parse::<Role>(), Ok(role));
            assert_eq!(role.to_string(), role.name());
        }
        assert_eq!(Role::default(), Role::All, "one process plays everything unless asked");
        assert!("world".parse::<Role>().is_err());
    }
}
