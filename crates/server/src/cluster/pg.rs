//! The directory among several processes: its leases in Postgres, behind the tiers' `Leases` trait
//! (crates/server/src/directory/leases.rs), each new simulation placed on the sim process with the
//! least to play (the instance pool: region channels and instance copies alike), and started there.
//!
//! The directory grants; each simulation's own process renews its lease (`keeper.rs`), so a sim
//! cut off from the database stops, and a directory that stops stops no simulation. The
//! directory's `renew` only looks: a lease run out (its process gone, or cut off) or granted to
//! another is lost, and the directory lets the space go and sends its players back in.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ruina_link::Node;
use ruina_world_api::directory::Lease;
use ruina_world_api::{Epoch, Millis, SimId, SpaceId};
use sqlx::PgPool;

use crate::cluster::leases::{self, Granted, Holder, Leased};
use crate::cluster::nodes::GONE_AFTER;
use crate::cluster::wire::{Spawn, Wire};
use crate::directory::leases::{Leases, Renewed};
use crate::directory::{SimSetup, Spawner};
use crate::store::now_ms;

/// Where each new simulation goes, and, once placed, where each went and when it was granted.
pub struct Placement {
    db: PgPool,
    placed: Mutex<HashMap<SimId, (String, String, Millis)>>,
}

impl Placement {
    pub fn new(db: PgPool) -> Arc<Placement> {
        Arc::new(Placement { db, placed: Mutex::default() })
    }

    /// The sim process heard from lately that plays fewest spaces now: its node and address. A
    /// process holding a lease it hasn't renewed since it was last heard from is passed over: it has
    /// stopped or been cut off, though it still counts as heard from for GONE_AFTER (a space it lost
    /// would otherwise go straight back to it, the least busy, and never be played).
    pub async fn pick(&self) -> Result<(String, String), String> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT n.id, n.address FROM nodes n \
             WHERE n.role = 'sim' AND n.seen_at > now() - $1 * interval '1 millisecond' \
             AND NOT EXISTS (SELECT 1 FROM space_leases f WHERE f.node = n.id AND f.sim IS NOT NULL \
                             AND f.expires_at <= now() AND f.expires_at >= n.seen_at) \
             ORDER BY (SELECT count(*) FROM space_leases l WHERE l.node = n.id AND l.sim IS NOT NULL AND l.expires_at > now()), n.id \
             LIMIT 1",
        )
        .bind(GONE_AFTER.as_millis() as i64)
        .fetch_optional(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        row.ok_or_else(|| "no simulation process is running".to_string())
    }

    /// Where `sim` was placed, and when it was granted.
    fn of(&self, sim: SimId) -> Option<(String, String, Millis)> {
        self.placed.lock().unwrap().get(&sim).cloned()
    }
}

/// The directory's leases in `space_leases`.
pub struct PgLeases {
    db: PgPool,
    place: Arc<Placement>,
    ttl: Duration,
}

impl PgLeases {
    pub fn new(db: PgPool, place: Arc<Placement>, ttl: Duration) -> PgLeases {
        PgLeases { db, place, ttl }
    }
}

fn leased(space: &SpaceId) -> Leased {
    Leased::space(space.to_string())
}

impl Leases for PgLeases {
    async fn next_sim(&self) -> Result<SimId, String> {
        leases::new_sim(&self.db).await.map(|n| SimId(n as u64)).map_err(|e| e.to_string())
    }

    /// Granted to `sim`, placed on a sim process; or, if a simulation plays the space already (the
    /// directory started again while it played on), that one's lease, to be taken as it is.
    async fn grant(&self, space: &SpaceId, sim: SimId, chunks: Vec<(i32, i32)>) -> Result<Lease, String> {
        let (node, address) = self.place.pick().await?;
        let asked = now_ms();
        let holder = Holder { sim: sim.0 as i64, node: node.clone(), address: address.clone() };
        let ttl = self.ttl.as_millis() as Millis;
        match leases::acquire(&self.db, &leased(space), &holder, &chunks, self.ttl).await.map_err(|e| e.to_string())? {
            Granted::Yes(l) => {
                self.place.placed.lock().unwrap().insert(sim, (node, address, asked));
                Ok(Lease { space: space.clone(), sim, epoch: Epoch(l.epoch as u64), until: asked + ttl, chunks })
            }
            Granted::Held(o) => Ok(Lease {
                space: space.clone(),
                sim: SimId(o.sim as u64),
                epoch: Epoch(o.epoch as u64),
                until: now_ms() + o.left.as_millis() as Millis,
                chunks,
            }),
        }
    }

    /// The simulations' own processes renew; this finds which of `held` are lost: run out, or
    /// granted to another since.
    async fn renew(&self, held: &[Lease]) -> Result<Renewed, String> {
        let keys: Vec<String> = held.iter().map(|l| l.space.to_string()).collect();
        let rows: Vec<(String, Option<i64>, i64, bool)> =
            sqlx::query_as("SELECT space, sim, epoch, expires_at > now() FROM space_leases WHERE part = 0 AND space = ANY($1)")
                .bind(&keys)
                .fetch_all(&self.db)
                .await
                .map_err(|e| e.to_string())?;
        let now: HashMap<String, (Option<i64>, i64, bool)> = rows.into_iter().map(|(s, sim, epoch, live)| (s, (sim, epoch, live))).collect();
        Ok(Renewed { until: now_ms() + self.ttl.as_millis() as Millis, lost: lost(held, &now) })
    }

    async fn release(&self, space: &SpaceId, sim: SimId) -> Result<(), String> {
        sqlx::query("UPDATE space_leases SET sim = NULL, node = NULL, address = NULL, expires_at = now() WHERE space = $1 AND part = 0 AND sim = $2")
            .bind(space.to_string())
            .bind(sim.0 as i64)
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        self.place.placed.lock().unwrap().remove(&sim);
        Ok(())
    }

    async fn owner(&self, space: &SpaceId) -> Result<Option<(SimId, Epoch)>, String> {
        let o = leases::owner(&self.db, &leased(space)).await.map_err(|e| e.to_string())?;
        Ok(o.map(|o| (SimId(o.sim as u64), Epoch(o.epoch as u64))))
    }
}

/// Which of the leases held are lost, by the rows as they are now (space key: its simulation, its
/// epoch, and whether it hasn't run out): those no longer there, let go, run out, or granted to
/// another simulation or under another epoch.
fn lost(held: &[Lease], now: &HashMap<String, (Option<i64>, i64, bool)>) -> Vec<Lease> {
    held.iter()
        .filter(|l| !matches!(now.get(&l.space.to_string()), Some((Some(sim), epoch, true)) if *sim == l.sim.0 as i64 && *epoch == l.epoch.0 as i64))
        .cloned()
        .collect()
}

/// Starts each simulation in the sim process it was placed on, over the link there.
pub struct RemoteSims {
    node: Node<Wire>,
    place: Arc<Placement>,
}

impl RemoteSims {
    pub fn new(node: Node<Wire>, place: Arc<Placement>) -> RemoteSims {
        RemoteSims { node, place }
    }
}

impl Spawner for RemoteSims {
    fn start(&self, setup: SimSetup) {
        let sim = setup.lease.sim;
        let Some((node, address, granted_ms)) = self.place.of(sim) else {
            eprintln!("directory: simulation {} for {} was placed nowhere", sim.0, setup.lease.space);
            return;
        };
        let spawn = Spawn { lease: setup.lease, owner: setup.owner, expel_after_ms: setup.expel_after.as_millis() as u64, granted_ms, part: setup.part };
        if let Err(e) = self.node.link(&node, &address).push(&Wire::Spawn(spawn)) {
            eprintln!("directory: couldn't start simulation {} on {node}: {e}", sim.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruina_link::{Config, Node};

    fn lease(space: &str, sim: u64, epoch: u64) -> Lease {
        Lease { space: space.parse().unwrap(), sim: SimId(sim), epoch: Epoch(epoch), until: 0, chunks: Vec::new() }
    }

    #[test]
    fn a_lease_is_lost_once_it_runs_out_is_let_go_or_is_granted_again() {
        let held = [
            lease("channel:emberholm:1", 1, 4),
            lease("channel:emberholm:2", 2, 1),
            lease("copy:yard:3", 3, 2),
            lease("copy:yard:4", 4, 7),
            lease("copy:yard:5", 5, 1),
            lease("copy:yard:6", 6, 1),
        ];
        let now: HashMap<String, (Option<i64>, i64, bool)> = [
            ("channel:emberholm:1", (Some(1), 4, true)),  // still its own
            ("channel:emberholm:2", (Some(2), 1, false)), // run out
            ("copy:yard:3", (Some(9), 3, true)),          // granted to another
            ("copy:yard:4", (Some(4), 8, true)),          // granted again, under a newer epoch
            ("copy:yard:5", (None, 1, false)),            // let go
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        // copy:yard:6 isn't there at all.
        let lost: Vec<u64> = lost(&held, &now).iter().map(|l| l.sim.0).collect();
        assert_eq!(lost, vec![2, 3, 4, 5, 6]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_simulation_is_started_in_the_process_it_was_placed_on() {
        // Never reached: the spawner only looks up where it placed the simulation.
        let db = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://ruina:ruina@127.0.0.1:1/ruina").unwrap();
        let place = Placement::new(db);
        let (sim_process, mut inbox) = Node::<Wire>::start("sim-1", "127.0.0.1:0", Config::speaking(crate::cluster::wire::PROTOCOL)).await.unwrap();
        let (services, _) = Node::<Wire>::start("services-1", "127.0.0.1:0", Config::speaking(crate::cluster::wire::PROTOCOL)).await.unwrap();
        place.placed.lock().unwrap().insert(SimId(8), ("sim-1".into(), sim_process.local_addr().to_string(), 1_000));
        let spawner = RemoteSims::new(services, place);
        let setup =
            SimSetup { lease: lease("copy:yard:12", 8, 3), owner: Some(ruina_world_api::Owner::Solo(7)), expel_after: Duration::from_secs(60), part: None };
        spawner.start(setup.clone());
        let e = tokio::time::timeout(Duration::from_secs(10), inbox.recv()).await.unwrap().unwrap();
        match e.msg {
            Wire::Spawn(s) => {
                assert_eq!((s.lease, s.owner, s.expel_after_ms, s.granted_ms), (setup.lease, setup.owner, 60_000, 1_000));
            }
            other => panic!("{other:?}"),
        }
        // A simulation placed nowhere isn't started anywhere.
        spawner.start(SimSetup { lease: lease("copy:yard:13", 9, 1), owner: None, expel_after: Duration::from_secs(60), part: None });
        assert!(tokio::time::timeout(Duration::from_millis(300), inbox.recv()).await.is_err());
    }
}
