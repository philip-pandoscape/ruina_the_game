//! A region played in parts by several simulations, each owning some of its chunks (R10.19,
//! crates/engine/src/border): where the parts are cut, which simulation owns each chunk of the world,
//! and the slots each part seats its own players in.

use std::ops::Range;

use ruina_engine::border::{Owners, SimId as BorderSim};
use ruina_engine::combat::MAX_PLAYERS;
use ruina_engine::open::map::WorldMap;
use ruina_world_api::SimId;

/// The most parts a region is played in: each seats its players in a quarter of the slots.
pub const MOST_PARTS: usize = 4;

/// Which part a chunk is in: one for each cut (a chunk's x) it lies at or east of.
fn part_of(cuts: &[i32], cx: i32) -> usize {
    cuts.iter().filter(|&&c| cx >= c).count()
}

/// A region's chunks in parts, cut along lines of chunks (each cut a chunk's x: west of it one part,
/// at or east of it the next), each part's chunks in order; parts with none are left out.
pub fn parts(chunks: &[(i32, i32)], cuts: &[i32]) -> Vec<Vec<(i32, i32)>> {
    let mut out: Vec<Vec<(i32, i32)>> = vec![Vec::new(); cuts.len() + 1];
    for &c in chunks {
        out[part_of(cuts, c.0)].push(c);
    }
    out.retain(|p| !p.is_empty());
    out
}

/// Who owns each chunk of `map`'s world: the simulation of the part it's in, cut as the region is
/// (`sims`, one for each part, west to east). The open sea and other regions go by the same cuts.
pub fn owners(map: &WorldMap, cuts: &[i32], sims: &[SimId]) -> Owners {
    Owners::of(map, |cx, _| BorderSim(sims[part_of(cuts, cx).min(sims.len() - 1)].0))
}

/// The slots part `k` seats its own players in: so a player keeps their slot wherever they cross.
pub fn seats(k: usize) -> Range<usize> {
    let each = MAX_PLAYERS / MOST_PARTS;
    k * each..(k + 1) * each
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruina_engine::open::map::world_map;

    #[test]
    fn emberholm_cut_at_x_0_is_two_parts_owned_by_their_simulations() {
        let map = world_map();
        let r = map.region("emberholm").expect("Emberholm");
        let chunks: Vec<(i32, i32)> = (r.chunks.x..r.chunks.x + r.chunks.w).flat_map(|x| (r.chunks.z..r.chunks.z + r.chunks.d).map(move |z| (x, z))).collect();
        let p = parts(&chunks, &[0]);
        assert_eq!(p.len(), 2);
        assert!(p[0].iter().all(|c| c.0 < 0) && p[1].iter().all(|c| c.0 >= 0));
        assert_eq!(p[0].len() + p[1].len(), chunks.len());
        // A cut past the region's edge leaves it whole.
        assert_eq!(parts(&chunks, &[10]).len(), 1);
        let o = owners(map, &[0], &[SimId(5), SimId(6)]);
        assert_eq!((o.owner_at(-1.0, 300.0), o.owner_at(1.0, -300.0)), (BorderSim(5), BorderSim(6)));
        // Each part's own players in slots of its own.
        assert_eq!((seats(0), seats(1)), (0..1024, 1024..2048));
    }
}
