//! A simulation's link to the others playing its region (border.rs): at each point of a tick it
//! sends each neighbour one parcel over the post (`ToSim::Border`), and goes on once it has every
//! neighbour's for that point (lockstep: a split region plays to the bit as one game does), or with
//! what has come so far (a tick late: for neighbours in other processes, should the multi-server
//! version choose it). Whatever other mail comes while it waits is kept for the next tick boundary.
//! A neighbour that says nothing for `patience` is gone on without, rather than waited on for ever.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::mpsc as std_mpsc;
use std::time::{Duration, Instant};

use ruina_engine::border::messages::{Barrier, Says};
use ruina_world_api::sim::{Parcel, ToSim};
use ruina_world_api::{SimId, Transport};

use super::border::Parcels;

/// How a simulation goes on at a point of a tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pace {
    /// Once every neighbour's parcel for the point has come.
    Lockstep,
    /// With what has come so far (the rest, a tick late).
    Late,
}

/// How long a simulation waits for a neighbour at a point before going on without it.
pub const PATIENCE: Duration = Duration::from_millis(250);

pub struct Link {
    pub me: SimId,
    pub neighbours: Vec<SimId>,
    pub pace: Pace,
    pub patience: Duration,
    /// Parcels that came before they were wanted, by whom and where, oldest first.
    early: BTreeMap<(SimId, Barrier), VecDeque<Parcel>>,
    /// Mail that came while it waited, for the next tick boundary.
    pub later: VecDeque<ToSim>,
}

impl Link {
    pub fn new(me: SimId, neighbours: Vec<SimId>) -> Link {
        Link { me, neighbours, pace: Pace::Lockstep, patience: PATIENCE, early: BTreeMap::new(), later: VecDeque::new() }
    }

    /// A parcel that came between trades (the host's mail): kept for when it's wanted.
    pub fn keep(&mut self, p: Parcel) {
        self.early.entry((SimId(p.from.0), p.at)).or_default().push_back(p);
    }

    /// Trades at `at` of tick `tick`: `out`'s posts to each neighbour they're for (each sent one
    /// parcel, empty or not, so it knows it has everything), with the members and names that go
    /// with them; and back what the neighbours sent there.
    pub fn trade(&mut self, inbox: &std_mpsc::Receiver<ToSim>, post: &dyn Transport, at: Barrier, tick: u64, out: Parcels) -> Parcels {
        for &n in &self.neighbours {
            let posts: Vec<_> = out.posts.iter().filter(|p| p.to.0 == n.0).cloned().collect();
            // Who goes with a handoff to it, and the names of the ghosts it's sent.
            let mut going = BTreeSet::new();
            let mut seen = BTreeSet::new();
            for p in &posts {
                match &p.says {
                    Says::Handoff(h) => going.extend(h.players.iter().filter_map(|m| m.client.as_character())),
                    Says::Ghosts(g) => seen.extend(g.players.iter().map(|gp| gp.client)),
                    _ => {}
                }
            }
            let members = out.members.iter().filter(|(c, _)| going.contains(c)).cloned().collect();
            let names = out.names.iter().filter(|(id, _, _)| seen.contains(id)).cloned().collect();
            let parcel = Parcel { from: self.me, tick, at, posts, members, names };
            post.sim(n, ToSim::Border(Box::new(parcel)));
        }
        let mut got = Parcels { tick, ..Parcels::default() };
        let mut want: BTreeSet<SimId> = self.neighbours.iter().copied().collect();
        let deadline = Instant::now() + self.patience;
        loop {
            for n in want.clone() {
                let Some(q) = self.early.get_mut(&(n, at)) else { continue };
                let taken: Vec<Parcel> = match self.pace {
                    Pace::Lockstep => q.pop_front().into_iter().collect(),
                    Pace::Late => q.drain(..).collect(),
                };
                if taken.is_empty() {
                    continue;
                }
                for p in taken {
                    got.tick = got.tick.max(p.tick);
                    got.posts.extend(p.posts);
                    got.members.extend(p.members);
                    got.names.extend(p.names);
                }
                want.remove(&n);
            }
            if want.is_empty() || self.pace == Pace::Late {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match inbox.recv_timeout(left) {
                Ok(ToSim::Border(p)) => self.keep(*p),
                Ok(other) => self.later.push_back(other),
                Err(std_mpsc::RecvTimeoutError::Timeout) => {
                    eprintln!("simulation {} went on without {:?} at {:?} of tick {tick}", self.me.0, want, at);
                    break;
                }
                Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        got
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::post::Post;
    use ruina_engine::border::SimId as BorderSim;
    use ruina_engine::border::messages::{Ghosts, Post as BorderPost};
    use ruina_world_api::Conn;

    fn parcel(from: u64, at: Barrier, tick: u64) -> Parcel {
        let post = BorderPost { from: BorderSim(from), to: BorderSim(1), tick, says: Says::Ghosts(Ghosts::default()) };
        Parcel { from: SimId(from), tick, at, posts: vec![post], members: Vec::new(), names: Vec::new() }
    }

    #[test]
    fn it_sends_each_neighbour_a_parcel_and_waits_for_each_of_theirs_keeping_the_rest_for_later() {
        let post = Post::new();
        let inbox = post.open_sim(SimId(1));
        let theirs = [post.open_sim(SimId(2)), post.open_sim(SimId(3))];
        let mut link = Link::new(SimId(1), vec![SimId(2), SimId(3)]);
        // One neighbour ahead already (its next point's parcel too); mail for the game meanwhile.
        post.sim(SimId(1), ToSim::Border(Box::new(parcel(2, Barrier::Inputs, 7))));
        post.sim(SimId(1), ToSim::Border(Box::new(parcel(2, Barrier::InputsTold, 7))));
        let conn = Conn { gate: ruina_world_api::GateId(1), character: 9, session: 1 };
        post.sim(SimId(1), ToSim::Depart { conn });
        post.sim(SimId(1), ToSim::Border(Box::new(parcel(3, Barrier::Inputs, 8))));
        let got = link.trade(&inbox, post.as_ref(), Barrier::Inputs, 7, Parcels::default());
        // Both neighbours' parcels for the point, the latest tick among them; the other point's
        // kept, and the game's mail for its next boundary.
        assert_eq!((got.posts.len(), got.tick), (2, 8));
        assert!(matches!(link.later.front(), Some(ToSim::Depart { .. })));
        let next = link.trade(&inbox, post.as_ref(), Barrier::InputsTold, 7, Parcels::default());
        assert_eq!(next.posts.len(), 1, "the one that came early; the other neighbour's isn't coming");
        // And each neighbour was sent one parcel for each point, empty as it was.
        for rx in &theirs {
            let sent: Vec<Barrier> = rx.try_iter().filter_map(|m| if let ToSim::Border(p) = m { Some(p.at) } else { None }).collect();
            assert_eq!(sent, vec![Barrier::Inputs, Barrier::InputsTold]);
        }
    }

    #[test]
    fn a_tick_late_it_takes_what_has_come_and_goes_on() {
        let post = Post::new();
        let inbox = post.open_sim(SimId(1));
        let _theirs = post.open_sim(SimId(2));
        let mut link = Link::new(SimId(1), vec![SimId(2)]);
        link.pace = Pace::Late;
        let start = Instant::now();
        assert!(link.trade(&inbox, post.as_ref(), Barrier::Seated, 3, Parcels::default()).posts.is_empty());
        assert!(start.elapsed() < PATIENCE, "it didn't wait");
        // What came meanwhile, for the next time it trades there.
        link.keep(parcel(2, Barrier::Seated, 3));
        assert_eq!(link.trade(&inbox, post.as_ref(), Barrier::Seated, 4, Parcels::default()).posts.len(), 1);
    }
}
