//! Borders: one world played by several simulations, each owning a set of its 256 m chunks, its
//! borders crossed as if they weren't there (`.plans/world/research.md` 3.2, `docs/world.md`).
//!
//! - **Ownership** ([`Owners`]): the simulation that owns a chunk steps whoever stands in it.
//! - **Ghosts** ([`messages::Ghosts`]): each simulation sends its neighbours read-only copies of the
//!   players and creatures it owns within [`BAND`] metres of their chunks, with the history lag
//!   compensation rewinds (crate::combat keeps 40 ticks), wherever a tick's phase reads what the one
//!   before it changed (below).
//! - **Handoff** ([`messages::Handoff`]): a player [`HANDOFF`] metres past the border is frozen at
//!   the end of a tick and sent whole under their next epoch; a driver goes with their passengers,
//!   and the vehicle and its cargo with its owner's life, as one unit. The neighbour takes them at the
//!   start of the next tick and says so ([`messages::Taken`]); the old owner keeps a ghost and
//!   forwards whatever reaches it for them; whatever is said of them under an older epoch is refused.
//! - **Across**: blows and heals on what a neighbour owns are events (crate::combat's `Across`),
//!   checked where the attacker is, against the ghost's history rewound to what the attacker saw, and
//!   landed by the owner among its own; what each meant for its dealer comes back to be told and
//!   credited in the order it landed. Creatures' slams and blows the same ([`messages::Struck`]).
//! - **Creatures** are leashed: owned by the simulation their home is in and never handed over, they
//!   see and strike the ghosts of players across the border.
//!
//! [`split::Split`] plays one world as several simulations in lockstep in one process, trading these
//! as plain values ([`messages::Post`]), and comes out bit for bit as one simulation does
//! (`checks/border.rs`). That needs a trade at every point where one phase reads what another
//! changed, as each phase lands its blows at its own end (R10.18): ghosts as the tick begins, blows
//! and heals after the inputs and what's told of them back, ghosts again for the arrows and meteors,
//! their blows and what's told of them, ghosts again for the creatures, their slams and blows, and
//! ghosts again for the history.
//!
//! What a simulation counts across all it owns is its own: a creature family's (a ladder's, a
//! band's) caps and respawns, and the numbers of what's born in a fight (pieces of a burst,
//! missiles, arrows). A region split between simulations stays exact while each family stands on one
//! side, as regions keep them (their homes away from borders, and leashed).

#[cfg(test)]
mod crossings;
pub mod messages;
pub mod sim;
pub mod split;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::open::map::WorldMap;

/// How far from its neighbour's chunks what a simulation owns is seen there, in metres: more than
/// anything reaches (a bow's 42 m, a meteor's 16 m and its blast, a bot's 40 m of sight) from as far
/// as anything strays past its border before it's handed over.
pub const BAND: f64 = 120.0;

/// How far past the border a player is handed over, in metres: so far either way that nothing
/// flickers back and forth (at 29 m/s, a second of running), checked every tick.
pub const HANDOFF: f64 = 28.0;

/// A simulation, by its number (the directory's; `SimId` in crates/world-api).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SimId(pub u64);

/// How many times a player has changed hands: bumped at every handoff. Whatever is said of them
/// under an older one is refused (a fencing token: Kleppmann's).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Epoch(pub u64);

impl Epoch {
    pub fn next(self) -> Epoch {
        Epoch(self.0 + 1)
    }
}

/// Which simulation owns each chunk of a world: what it steps, and whom what stands in it is handed
/// to once it's past the border (the directory's table). Every chunk of the world's edge (its
/// regions' chunks together, the open sea between them included) is named; anything past it, where
/// nothing can stand, is `rest`'s.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(from = "OwnersForm", into = "OwnersForm")]
pub struct Owners {
    /// Metres a chunk is on a side.
    pub chunk: f64,
    table: BTreeMap<(i32, i32), SimId>,
    rest: SimId,
}

/// How [`Owners`] is written: each chunk as `[x, z, sim]`.
#[derive(Clone, Serialize, Deserialize)]
struct OwnersForm {
    chunk: f64,
    chunks: Vec<(i32, i32, SimId)>,
    rest: SimId,
}

impl From<OwnersForm> for Owners {
    fn from(f: OwnersForm) -> Owners {
        Owners { chunk: f.chunk, table: f.chunks.into_iter().map(|(x, z, s)| ((x, z), s)).collect(), rest: f.rest }
    }
}

impl From<Owners> for OwnersForm {
    fn from(o: Owners) -> OwnersForm {
        OwnersForm { chunk: o.chunk, chunks: o.table.into_iter().map(|((x, z), s)| (x, z, s)).collect(), rest: o.rest }
    }
}

impl Owners {
    /// Every chunk of `map`'s world given to whoever `who` says (by the chunk's x and z).
    pub fn of(map: &WorldMap, who: impl Fn(i32, i32) -> SimId) -> Owners {
        Owners::grid(map, map.chunk, who)
    }

    /// The same in chunks of `chunk` metres rather than the world's: finer, to check the border's
    /// workings where a fight is, without moving the fight onto a line of the world's chunks.
    pub fn grid(map: &WorldMap, chunk: f64, who: impl Fn(i32, i32) -> SimId) -> Owners {
        let (mut x0, mut z0, mut x1, mut z1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for r in map.regions() {
            let c = r.chunks;
            x0 = x0.min(f64::from(c.x) * map.chunk);
            z0 = z0.min(f64::from(c.z) * map.chunk);
            x1 = x1.max(f64::from(c.x + c.w) * map.chunk);
            z1 = z1.max(f64::from(c.z + c.d) * map.chunk);
        }
        let mut table = BTreeMap::new();
        let cell = |v: f64| (v / chunk).floor() as i32;
        if x0 <= x1 {
            for cx in cell(x0)..cell(x1 - 1e-9) + 1 {
                for cz in cell(z0)..cell(z1 - 1e-9) + 1 {
                    table.insert((cx, cz), who(cx, cz));
                }
            }
        }
        let rest = table.values().next().copied().unwrap_or_default();
        Owners { chunk, table, rest }
    }

    /// The whole world one simulation's.
    pub fn one(map: &WorldMap, sim: SimId) -> Owners {
        Owners::of(map, |_, _| sim)
    }

    /// The world split along a line of chunks: those west of chunk `x` (less than it) `west`'s, the
    /// rest `east`'s.
    pub fn split_x(map: &WorldMap, x: i32, west: SimId, east: SimId) -> Owners {
        Owners::of(map, |cx, _| if cx < x { west } else { east })
    }

    /// The simulation that owns chunk (`cx`, `cz`).
    pub fn owner(&self, cx: i32, cz: i32) -> SimId {
        self.table.get(&(cx, cz)).copied().unwrap_or(self.rest)
    }

    /// The chunk a point is in.
    pub fn chunk_of(&self, x: f64, z: f64) -> (i32, i32) {
        ((x / self.chunk).floor() as i32, (z / self.chunk).floor() as i32)
    }

    /// The simulation that owns the chunk a point is in.
    pub fn owner_at(&self, x: f64, z: f64) -> SimId {
        let (cx, cz) = self.chunk_of(x, z);
        self.owner(cx, cz)
    }

    /// Every simulation that owns a chunk, in order.
    pub fn sims(&self) -> Vec<SimId> {
        let mut s: Vec<SimId> = self.table.values().copied().chain([self.rest]).collect();
        s.sort();
        s.dedup();
        s
    }

    /// How far a point is from chunk (`kx`, `kz`), squared (0 inside it).
    fn to_chunk2(&self, kx: i32, kz: i32, x: f64, z: f64) -> f64 {
        let (x0, z0) = (f64::from(kx) * self.chunk, f64::from(kz) * self.chunk);
        let ox = (x0 - x).max(0.0).max(x - (x0 + self.chunk));
        let oz = (z0 - z).max(0.0).max(z - (z0 + self.chunk));
        ox * ox + oz * oz
    }

    /// How far a point is from the nearest chunk `sim` owns, squared, if that's within `r` metres
    /// of it (0 inside one): the chunks round the point's own, ring by ring, out to `r`.
    pub fn nearest2(&self, sim: SimId, x: f64, z: f64, r: f64) -> Option<f64> {
        let (cx, cz) = self.chunk_of(x, z);
        let rings = (r / self.chunk).ceil() as i32 + 1;
        let mut best: Option<f64> = None;
        for d in 0..=rings {
            // Nothing in this ring or past it is nearer than the ring's inner edge.
            let inner = f64::from((d - 1).max(0)) * self.chunk;
            if inner > r || best.is_some_and(|b| inner * inner > b) {
                break;
            }
            for dx in -d..=d {
                for dz in -d..=d {
                    if dx.abs() != d && dz.abs() != d {
                        continue;
                    }
                    let (kx, kz) = (cx + dx, cz + dz);
                    if self.owner(kx, kz) != sim {
                        continue;
                    }
                    let d2 = self.to_chunk2(kx, kz, x, z);
                    if best.is_none_or(|b| d2 < b) {
                        best = Some(d2);
                    }
                }
            }
        }
        best.filter(|&d2| d2 <= r * r)
    }

    /// Whether a point is within `r` metres of a chunk `sim` owns.
    pub fn within(&self, sim: SimId, x: f64, z: f64, r: f64) -> bool {
        self.nearest2(sim, x, z, r).is_some()
    }

    /// The simulations other than `not` that own a chunk within `r` metres of a point, in order.
    pub fn near(&self, not: SimId, x: f64, z: f64, r: f64) -> Vec<SimId> {
        self.sims().into_iter().filter(|&s| s != not && self.within(s, x, z, r)).collect()
    }

    /// Whom something `sim` owns at a point is handed to: the owner of the chunk it stands in, once
    /// it's [`HANDOFF`] metres past `sim`'s border. None while it's `sim`'s still.
    pub fn handed_to(&self, sim: SimId, x: f64, z: f64) -> Option<SimId> {
        let here = self.owner_at(x, z);
        let past = self.nearest2(sim, x, z, HANDOFF).is_none_or(|d2| d2 >= HANDOFF * HANDOFF);
        (here != sim && past).then_some(here)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::map::world_map;

    #[test]
    fn emberholm_split_at_x_0_hands_over_past_the_border_and_not_before() {
        let map = world_map();
        let (a, b) = (SimId(1), SimId(2));
        let o = Owners::split_x(map, 0, a, b);
        assert_eq!(o.sims(), vec![a, b]);
        assert_eq!((o.owner_at(-1.0, 100.0), o.owner_at(1.0, 100.0)), (a, b));
        // Walking east from a's side: b's ground from x = 0, but still a's until 28 m past it.
        assert_eq!(o.handed_to(a, -5.0, 0.0), None);
        assert_eq!(o.handed_to(a, 20.0, 0.0), None);
        assert_eq!(o.handed_to(a, 27.9, 0.0), None);
        assert_eq!(o.handed_to(a, 28.0, 0.0), Some(b));
        // And back west: b's until 28 m past the border the other way, so nothing flickers.
        assert_eq!(o.handed_to(b, -27.9, 0.0), None);
        assert_eq!(o.handed_to(b, -28.0, 0.0), Some(a));
        // Seen across the border out to the band, and no farther.
        assert_eq!(o.near(a, -119.0, 0.0, BAND), vec![b]);
        assert!(o.near(a, -121.0, 0.0, BAND).is_empty());
        assert_eq!(o.near(b, 119.0, 0.0, BAND), vec![a]);
    }

    #[test]
    fn where_four_meet_each_corner_sees_the_other_three() {
        let map = world_map();
        let o = Owners::of(map, |cx, cz| SimId(1 + u64::from(cx >= 0) + 2 * u64::from(cz >= 0)));
        assert_eq!(o.sims(), vec![SimId(1), SimId(2), SimId(3), SimId(4)]);
        assert_eq!(o.near(SimId(1), -10.0, -10.0, BAND), vec![SimId(2), SimId(3), SimId(4)]);
        // Diagonally across the corner, the corner itself is the nearest of its ground.
        assert_eq!(o.handed_to(SimId(1), 19.0, 19.0), None);
        assert_eq!(o.handed_to(SimId(1), 20.0, 20.0), Some(SimId(4)));
    }

    #[test]
    fn the_table_is_written_and_read_back_whole() {
        let o = Owners::split_x(world_map(), 0, SimId(1), SimId(2));
        let text = serde_json::to_string(&o).expect("written");
        let back: Owners = serde_json::from_str(&text).expect("read");
        assert_eq!(back, o);
        assert!(text.contains("[-3,-3,1]") && text.contains("[2,2,2]"), "{text}");
    }
}
