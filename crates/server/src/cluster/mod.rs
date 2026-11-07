//! The world on several processes (`docs/architecture.md`, Where It's Going; `docs/deploys.md`,
//! Several Processes). `ruina-server` plays every tier in one process by default (`--role all`, as
//! Railway's beta does), or one role per process:
//!
//! - **gate**: players' connections; finds the sims through the directory and keeps a link to each.
//! - **sim**: plays spaces (a region's channel, an instance's copy), each under a lease with an
//!   epoch; one that can't renew a lease stops playing that space before it runs out.
//! - **services**: the directory's housekeeping (forgetting processes gone), and in time the store
//!   and social tiers.
//!
//! Processes find each other through the directory's tables in Postgres (`nodes`: every process,
//! its role and where its links take messages; `space_leases`: which sim plays what, under which
//! epoch) and talk over links (`crates/link`).
//!
//! Today (the first half of the multi-server version) the roles are scaffolding: a sim plays a
//! space as a stand-in (`roles.rs`: the world's ticks counted, a snapshot written under its fence
//! every second, carried on by whoever takes the space over), and the processes say `Msg`s to each
//! other, not yet the tiers' (world-api's) messages, which cross the links once the tiers do.
//!
//! - `leases.rs`: grants, renewals, owners, the fence every write passes, snapshots.
//! - `keeper.rs`: a sim's lease keeper, stopping the sim before its lease runs out.
//! - `nodes.rs`: the processes, their heartbeats and their sweep.
//! - `roles.rs`: what each role runs, and its status page (`/api/cluster`).

pub mod keeper;
pub mod leases;
pub mod nodes;
pub mod roles;

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

/// What the processes say to each other on their links while the tiers still pass their messages
/// in one process: who they are and what they play, and numbered messages the harness counts
/// (`crates/server/tests/cluster.rs`). The tiers' messages (world-api's, `ruina_link::post`) cross
/// the same links once the gate and the sims run apart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Msg {
    /// What do you play? (a request, answered with `Here`)
    Status,
    Here(Status),
    /// A numbered message on a stream, counted by its receiver.
    Count {
        stream: u64,
        n: u64,
    },
    /// How many of a stream have you had, and were they in order? (a request, answered with
    /// `Counted`)
    Tally {
        stream: u64,
    },
    Counted {
        stream: u64,
        received: u64,
        in_order: bool,
        last: u64,
    },
}

/// The protocol the processes speak on their links today.
pub const PROTOCOL: &str = "cluster/1";

/// A process as it says it is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub node: String,
    pub role: Role,
    pub incarnation: u64,
    /// What it plays (a sim), or has played since it started.
    pub spaces: Vec<Playing>,
    /// Messages its links delivered, and those that came again and were dropped.
    pub delivered: u64,
    pub duplicates: u64,
}

/// A space a sim plays, or played.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playing {
    pub space: String,
    pub part: i32,
    pub sim: i64,
    pub epoch: i64,
    /// The world's tick it has played to.
    pub tick: i64,
    /// Whether it plays it now.
    pub holding: bool,
    /// The snapshot it carried on from, if any: the epoch and tick it was written at.
    pub resumed: Option<(i64, i64)>,
    /// When it stopped (wall clock, ms), and why.
    pub stopped_at: Option<i64>,
    pub why: Option<String>,
}
