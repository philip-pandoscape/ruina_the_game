//! A simulation's lease keeper: renews its lease about every 2 s, and stops it before the lease runs
//! out if it can't.
//!
//! The database's clock decides when a lease runs out (`expires_at`, set `ttl` after the renewal ran
//! there). The keeper can't read that clock, but a renewal it sent at `sent` ran after `sent`, so
//! the lease lasts at least until `sent + ttl` by any clock that keeps time. It stops the sim
//! `margin` before that: at `sent + ttl - margin` after the last renewal that came back, if none
//! has since. `holding()` reads that deadline against the clock itself, so a sim checking it each
//! tick stops in time even if the keeper's own task is held up; and anything it writes after is
//! refused by the fence anyway.
//!
//! What the keeper says maps onto world-api's `LeaseNote` (`Renewed { epoch, until }`,
//! `Lost { epoch }`), which the directory tier sends its simulations.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sqlx::PgPool;
use tokio::sync::watch;

use crate::cluster::leases::{self, Lease};

/// How long a lease lasts, how often it's renewed, and how long before it runs out a sim stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub ttl: Duration,
    pub renew_every: Duration,
    pub margin: Duration,
    /// How long one renewal may take before it's given up and tried again.
    pub attempt: Duration,
}

impl Default for Timing {
    /// A lease of 10 s, renewed every 2 s; a sim that can't renew stops 2 s before it runs out.
    fn default() -> Self {
        Timing { ttl: Duration::from_secs(10), renew_every: Duration::from_secs(2), margin: Duration::from_secs(2), attempt: Duration::from_millis(1500) }
    }
}

impl Timing {
    /// The default proportions for a lease of `ttl`: renewed every fifth of it, stopping a fifth
    /// before it runs out (tests use leases of a second or two).
    pub fn of(ttl: Duration) -> Timing {
        Timing { ttl, renew_every: ttl / 5, margin: ttl / 5, attempt: ttl * 3 / 20 }
    }
}

/// Why a lease was lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lost {
    /// The database said no: it ran out, or another simulation was granted the space.
    Gone,
    /// No renewal came back before the deadline: the sim stopped while the lease was still its own.
    Unreachable,
    /// Let go on purpose (the sim stopping cleanly).
    Released,
}

/// What the keeper says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kept {
    /// Held, until the deadline (stop then unless renewed again). `until` in wall-clock ms, as
    /// world-api's `LeaseNote::Renewed` carries it.
    Holding {
        epoch: i64,
        until: i64,
    },
    Lost {
        epoch: i64,
        why: Lost,
    },
}

struct Shared {
    /// The deadline, in nanoseconds after `base`.
    deadline: AtomicU64,
    lost: AtomicBool,
    base: Instant,
}

/// Keeps one lease. Dropping it stops renewing (the lease runs out); `release` lets it go at once.
pub struct Keeper {
    lease: Lease,
    shared: Arc<Shared>,
    said: watch::Receiver<Kept>,
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
    db: PgPool,
}

fn wall_ms(at: Instant) -> i64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let ahead = at.saturating_duration_since(Instant::now()).as_millis() as i64;
    let behind = Instant::now().saturating_duration_since(at).as_millis() as i64;
    now + ahead - behind
}

impl Keeper {
    /// Keeps `lease`, granted by a request sent at `asked` (taken just before `acquire`).
    pub fn start(db: PgPool, lease: Lease, timing: Timing, asked: Instant) -> Keeper {
        let base = asked;
        let first = timing.ttl.saturating_sub(timing.margin);
        let shared = Arc::new(Shared { deadline: AtomicU64::new(first.as_nanos() as u64), lost: AtomicBool::new(false), base });
        let (tell, said) = watch::channel(Kept::Holding { epoch: lease.epoch, until: wall_ms(asked + first) });
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(keep(db.clone(), lease.clone(), timing, shared.clone(), tell, stopped));
        Keeper { lease, shared, said, stop, task: Some(task), db }
    }

    pub fn lease(&self) -> &Lease {
        &self.lease
    }

    /// When the sim must have stopped, unless renewed before then.
    pub fn deadline(&self) -> Instant {
        self.shared.base + Duration::from_nanos(self.shared.deadline.load(Ordering::Acquire))
    }

    /// Whether the sim may go on: the lease isn't lost and its deadline hasn't come. Cheap enough to
    /// ask every tick, and true to the clock even if the keeper's task is held up.
    pub fn holding(&self) -> bool {
        !self.shared.lost.load(Ordering::Acquire) && Instant::now() < self.deadline()
    }

    /// What the keeper says, as it changes.
    pub fn notes(&self) -> watch::Receiver<Kept> {
        self.said.clone()
    }

    /// Resolves once the lease is lost (or let go), with why.
    pub async fn lost(&self) -> Lost {
        let mut said = self.said.clone();
        loop {
            if let Kept::Lost { why, .. } = *said.borrow_and_update() {
                return why;
            }
            if said.changed().await.is_err() {
                return Lost::Gone;
            }
        }
    }

    /// Stops renewing and lets the lease go, so the next simulation takes the space at once.
    pub async fn release(mut self) -> sqlx::Result<bool> {
        self.stop.send_replace(true);
        self.shared.lost.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        leases::release(&self.db, &self.lease).await
    }
}

impl Drop for Keeper {
    fn drop(&mut self) {
        self.shared.lost.store(true, Ordering::Release);
        self.stop.send_replace(true);
    }
}

async fn keep(db: PgPool, lease: Lease, timing: Timing, shared: Arc<Shared>, tell: watch::Sender<Kept>, mut stop: watch::Receiver<bool>) {
    let deadline = |s: &Shared| s.base + Duration::from_nanos(s.deadline.load(Ordering::Acquire));
    let lose = |why: Lost| {
        shared.lost.store(true, Ordering::Release);
        tell.send_replace(Kept::Lost { epoch: lease.epoch, why });
    };
    let mut next = shared.base + timing.renew_every;
    loop {
        let end = deadline(&shared);
        tokio::select! {
            _ = tokio::time::sleep_until(next.min(end).into()) => {}
            _ = stopped(&mut stop) => {
                tell.send_replace(Kept::Lost { epoch: lease.epoch, why: Lost::Released });
                return;
            }
        }
        if Instant::now() >= end {
            return lose(Lost::Unreachable);
        }
        let sent = Instant::now();
        let renewed = tokio::select! {
            r = tokio::time::timeout(timing.attempt, leases::renew(&db, &lease, timing.ttl)) => r,
            _ = tokio::time::sleep_until(end.into()) => return lose(Lost::Unreachable),
            _ = stopped(&mut stop) => {
                tell.send_replace(Kept::Lost { epoch: lease.epoch, why: Lost::Released });
                return;
            }
        };
        match renewed {
            Ok(Ok(true)) => {
                let until = sent + timing.ttl.saturating_sub(timing.margin);
                // Never earlier than it was (a renewal that came back late says less than one before it).
                if until > deadline(&shared) {
                    shared.deadline.store(until.duration_since(shared.base).as_nanos() as u64, Ordering::Release);
                }
                tell.send_replace(Kept::Holding { epoch: lease.epoch, until: wall_ms(deadline(&shared)) });
                next = sent + timing.renew_every;
            }
            Ok(Ok(false)) => return lose(Lost::Gone),
            // The database didn't answer, or answered with an error: try again soon, until the deadline.
            Ok(Err(_)) | Err(_) => next = Instant::now() + (timing.renew_every / 4).max(Duration::from_millis(20)),
        }
    }
}

/// Resolves once `stop` says so (holding no lock on it when it does).
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|s| *s).await;
}
