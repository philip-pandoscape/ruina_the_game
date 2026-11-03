//! Builds each player's personal update. Fighters near the player are sent every tick with full
//! detail; fighters further out are sent less often; everyone else arrives in the shared FAR message.

use crate::protocol::{put_mid, put_near, MID_ENTRY, MSG_SNAPSHOT, NEAR_ENTRY};
use crate::sim::Battle;

pub const NEAR_RADIUS: f32 = 30.0;
pub const NEAR_CAP: usize = 256;
pub const MID_RADIUS: f32 = 90.0;
pub const MID_CAP: usize = 2000;
pub const MID_EVERY: u64 = 4; // mid-range fighters go out every 4th tick (5 times a second at 20 Hz)

const CELL: f32 = 4.0;
const HALF: f32 = 160.0;
const GRID: i32 = 80;

fn cell_coord(v: f32) -> i32 {
    (((v + HALF) / CELL).floor() as i32).clamp(0, GRID - 1)
}

// A grid of all fighters, rebuilt once per tick and shared by every player's search.
pub struct InterestGrid {
    head: Vec<i32>,
    next: Vec<i32>,
}

impl InterestGrid {
    pub fn new(n: usize) -> Self {
        InterestGrid { head: vec![-1; (GRID * GRID) as usize], next: vec![-1; n] }
    }

    pub fn rebuild(&mut self, b: &Battle) {
        self.head.fill(-1);
        for i in 0..b.n {
            let c = (cell_coord(b.z[i]) * GRID + cell_coord(b.x[i])) as usize;
            self.next[i] = self.head[c];
            self.head[c] = i as i32;
        }
    }
}

// Each fighter's bytes, packed once per tick. Every player's update copies from here instead of
// rounding and packing the same fighter again for each player who can see it.
pub struct Records {
    near: Vec<[u8; NEAR_ENTRY]>,
    mid: Vec<[u8; MID_ENTRY]>,
}

impl Records {
    pub fn new(n: usize) -> Self {
        Records { near: vec![[0; NEAR_ENTRY]; n], mid: vec![[0; MID_ENTRY]; n] }
    }

    pub fn rebuild(&mut self, b: &Battle) {
        let mut tmp = Vec::with_capacity(NEAR_ENTRY);
        for i in 0..b.n {
            tmp.clear();
            put_near(&mut tmp, b, i);
            self.near[i].copy_from_slice(&tmp);
            tmp.clear();
            put_mid(&mut tmp, b, i);
            self.mid[i].copy_from_slice(&tmp);
        }
    }
}

// Reused per worker thread so building a snapshot doesn't allocate.
#[derive(Default)]
pub struct Scratch {
    cand: Vec<(f32, u32)>, // (distance², fighter id)
}

fn closest_first(v: &mut [(f32, u32)], cap: usize) -> usize {
    if v.len() > cap {
        v.select_nth_unstable_by(cap, |a, b| a.0.total_cmp(&b.0));
        cap
    } else {
        v.len()
    }
}

/// Collects fighters around (vx, vz), searching outward one ring of cells at a time and stopping
/// once `want` have been found. In a dense crowd that stops early, so the cost per player stays
/// about the same no matter how many fighters are packed together.
fn gather(b: &Battle, g: &InterestGrid, vx: f32, vz: f32, max_r: f32, want: usize, cand: &mut Vec<(f32, u32)>) {
    cand.clear();
    let r2 = max_r * max_r;
    let (cx, cz) = (cell_coord(vx), cell_coord(vz));
    let max_ring = (max_r / CELL).ceil() as i32;
    let visit = |gx: i32, gz: i32, cand: &mut Vec<(f32, u32)>| {
        if gx < 0 || gz < 0 || gx >= GRID || gz >= GRID {
            return;
        }
        let mut j = g.head[(gz * GRID + gx) as usize];
        while j != -1 {
            let ju = j as usize;
            let (dx, dz) = (b.x[ju] - vx, b.z[ju] - vz);
            let d2 = dx * dx + dz * dz;
            if d2 <= r2 {
                cand.push((d2, ju as u32));
            }
            j = g.next[ju];
        }
    };
    for r in 0..=max_ring {
        if r == 0 {
            visit(cx, cz, cand);
        } else {
            for gx in cx - r..=cx + r {
                visit(gx, cz - r, cand);
                visit(gx, cz + r, cand);
            }
            for gz in cz - r + 1..=cz + r - 1 {
                visit(cx - r, gz, cand);
                visit(cx + r, gz, cand);
            }
        }
        if cand.len() >= want {
            break;
        }
    }
}

/// Writes one SNAPSHOT message for a player standing at (vx, vz) into `out`.
pub fn build_snapshot(
    b: &Battle,
    g: &InterestGrid,
    rec: &Records,
    vx: f32,
    vz: f32,
    mid_tick: bool,
    s: &mut Scratch,
    out: &mut Vec<u8>,
) {
    out.clear();
    out.push(MSG_SNAPSHOT);
    out.extend_from_slice(&(b.tick as u32).to_le_bytes());

    let (max_r, want) = if mid_tick { (MID_RADIUS, NEAR_CAP + MID_CAP) } else { (NEAR_RADIUS, NEAR_CAP) };
    gather(b, g, vx, vz, max_r, want, &mut s.cand);

    // Move everything within the near radius to the front, then keep the closest NEAR_CAP.
    let near_r2 = NEAR_RADIUS * NEAR_RADIUS;
    let mut split = 0;
    for k in 0..s.cand.len() {
        if s.cand[k].0 <= near_r2 {
            s.cand.swap(split, k);
            split += 1;
        }
    }
    let near_count = closest_first(&mut s.cand[..split], NEAR_CAP);
    out.reserve(4 + near_count * NEAR_ENTRY + if mid_tick { MID_CAP * MID_ENTRY } else { 0 });
    out.extend_from_slice(&(near_count as u16).to_le_bytes());
    for &(_, id) in &s.cand[..near_count] {
        out.extend_from_slice(&rec.near[id as usize]);
    }

    if mid_tick {
        // Everything else found, including near fighters that didn't fit under the cap.
        let rest = &mut s.cand[near_count..];
        let mid_count = closest_first(rest, MID_CAP);
        out.extend_from_slice(&(mid_count as u16).to_le_bytes());
        for &(_, id) in &rest[..mid_count] {
            out.extend_from_slice(&rec.mid[id as usize]);
        }
    } else {
        out.extend_from_slice(&0u16.to_le_bytes());
    }
}
