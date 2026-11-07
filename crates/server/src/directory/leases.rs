//! Spaces' leases: which simulation plays each space, under which epoch, until when. Every grant
//! bumps the space's epoch; the directory renews what it holds every few seconds, and releases a
//! space when its simulation stops. One process keeps them in memory (`MemoryLeases`); the
//! multi-server version keeps them in Postgres (its `space_leases`, shared by every process, behind
//! this same trait), where a simulation that can't renew stops before its lease runs out.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use ruina_world_api::directory::Lease;
use ruina_world_api::{Epoch, Millis, SimId, SpaceId};

use crate::store::now_ms;

/// How long a lease lasts unless renewed.
pub const LEASE_FOR: Duration = Duration::from_secs(10);
/// How often the directory renews the leases it holds.
pub const RENEW_EVERY: Duration = Duration::from_secs(2);

/// Where the leases are kept.
pub trait Leases: Send + Sync + 'static {
    /// A new simulation's id, never used before on this world.
    fn next_sim(&self) -> impl Future<Output = Result<SimId, String>> + Send;
    /// Grants `space` to `sim`, bumping its epoch: the lease.
    fn grant(&self, space: &SpaceId, sim: SimId, chunks: Vec<(i32, i32)>) -> impl Future<Output = Result<Lease, String>> + Send;
    /// Renews the leases held (each as granted): those that were, with their new time, and those
    /// another holder has taken since, which are lost.
    fn renew(&self, held: &[Lease]) -> impl Future<Output = Result<Renewed, String>> + Send;
    /// Gives a space up (its simulation stopped).
    fn release(&self, space: &SpaceId, sim: SimId) -> impl Future<Output = Result<(), String>> + Send;
    /// Who plays a space now, under which epoch.
    fn owner(&self, space: &SpaceId) -> impl Future<Output = Result<Option<(SimId, Epoch)>, String>> + Send;
}

/// What a renewal found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Renewed {
    pub until: Millis,
    pub lost: Vec<Lease>,
}

/// The leases of one process, in memory.
#[derive(Default)]
pub struct MemoryLeases {
    rows: Mutex<Rows>,
}

#[derive(Default)]
struct Rows {
    leases: BTreeMap<SpaceId, (SimId, Epoch, Millis)>,
    /// Epochs outlive their leases: a space granted again carries on from where it was.
    epochs: BTreeMap<SpaceId, Epoch>,
    sims: u64,
}

impl MemoryLeases {
    fn rows(&self) -> std::sync::MutexGuard<'_, Rows> {
        self.rows.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn until() -> Millis {
    now_ms() + LEASE_FOR.as_millis() as Millis
}

impl Leases for MemoryLeases {
    async fn next_sim(&self) -> Result<SimId, String> {
        let mut r = self.rows();
        r.sims += 1;
        Ok(SimId(r.sims))
    }

    async fn grant(&self, space: &SpaceId, sim: SimId, chunks: Vec<(i32, i32)>) -> Result<Lease, String> {
        let mut r = self.rows();
        let epoch = r.epochs.get(space).copied().unwrap_or_default().next();
        r.epochs.insert(space.clone(), epoch);
        let until = until();
        r.leases.insert(space.clone(), (sim, epoch, until));
        Ok(Lease { space: space.clone(), sim, epoch, until, chunks })
    }

    async fn renew(&self, held: &[Lease]) -> Result<Renewed, String> {
        let mut r = self.rows();
        let until = until();
        let mut lost = Vec::new();
        for l in held {
            match r.leases.get_mut(&l.space) {
                Some(row) if row.0 == l.sim && row.1 == l.epoch => row.2 = until,
                _ => lost.push(l.clone()),
            }
        }
        Ok(Renewed { until, lost })
    }

    async fn release(&self, space: &SpaceId, sim: SimId) -> Result<(), String> {
        let mut r = self.rows();
        if r.leases.get(space).is_some_and(|row| row.0 == sim) {
            r.leases.remove(space);
        }
        Ok(())
    }

    async fn owner(&self, space: &SpaceId) -> Result<Option<(SimId, Epoch)>, String> {
        let r = self.rows();
        Ok(r.leases.get(space).filter(|row| row.2 > now_ms()).map(|row| (row.0, row.1)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_grant_bumps_the_epoch_and_a_lease_taken_is_lost_to_its_holder() {
        let l = MemoryLeases::default();
        let space = SpaceId::channel("emberholm", 1);
        let (a, b) = (l.next_sim().await.unwrap(), l.next_sim().await.unwrap());
        assert_ne!(a, b);
        let first = l.grant(&space, a, vec![(0, 0)]).await.unwrap();
        assert_eq!(first.epoch, Epoch(1));
        assert_eq!(l.owner(&space).await.unwrap(), Some((a, Epoch(1))));
        // Renewed while it's held.
        let r = l.renew(std::slice::from_ref(&first)).await.unwrap();
        assert!(r.lost.is_empty() && r.until >= first.until);
        // Granted to another (a simulation started in its place): a newer epoch, and the first's
        // renewal finds it lost.
        let second = l.grant(&space, b, vec![]).await.unwrap();
        assert_eq!(second.epoch, Epoch(2));
        assert_eq!(l.renew(std::slice::from_ref(&first)).await.unwrap().lost, vec![first.clone()]);
        // Released by the one that lost it: nothing changes. By its holder: free, and granted again
        // it carries on from its epoch.
        l.release(&space, a).await.unwrap();
        assert_eq!(l.owner(&space).await.unwrap(), Some((b, Epoch(2))));
        l.release(&space, b).await.unwrap();
        assert_eq!(l.owner(&space).await.unwrap(), None);
        assert_eq!(l.grant(&space, a, vec![]).await.unwrap().epoch, Epoch(3));
    }
}
