//! Everything solid in an open world, bucketed on a coarse grid so a query only looks at what is
//! nearby. A port of src/sim/zone/colliders.ts: the same buckets, visited in the same order.

use std::collections::{HashMap, HashSet};

use super::zone::{BoxCollider, Deck, Heightfield, Obstacle};

const BUCKET: f64 = 16.0;

#[derive(Clone, Default)]
pub struct ColliderIndex {
    pub obstacles: Vec<Obstacle>,
    pub boxes: Vec<BoxCollider>,
    pub decks: Vec<Deck>,
    obstacle_cells: HashMap<i64, Vec<usize>>,
    box_cells: HashMap<i64, Vec<usize>>,
    deck_cells: HashMap<i64, Vec<usize>>,
}

fn key(bx: i64, bz: i64) -> i64 {
    (bx + 2048) * 4096 + (bz + 2048)
}

fn span(x: f64, z: f64, r: f64) -> (i64, i64, i64, i64) {
    (((x - r) / BUCKET).floor() as i64, ((x + r) / BUCKET).floor() as i64, ((z - r) / BUCKET).floor() as i64, ((z + r) / BUCKET).floor() as i64)
}

fn insert(cells: &mut HashMap<i64, Vec<usize>>, x: f64, z: f64, r: f64, i: usize) {
    let (x0, x1, z0, z1) = span(x, z, r);
    for bx in x0..=x1 {
        for bz in z0..=z1 {
            cells.entry(key(bx, bz)).or_default().push(i);
        }
    }
}

/// Indices of everything listed near (x, z), each once, in the order the TypeScript visits them.
fn visit(cells: &HashMap<i64, Vec<usize>>, x: f64, z: f64, r: f64, out: &mut Vec<usize>) {
    out.clear();
    let (x0, x1, z0, z1) = span(x, z, r);
    if x0 == x1 && z0 == z1 {
        if let Some(list) = cells.get(&key(x0, z0)) {
            out.extend_from_slice(list);
        }
        return;
    }
    // A thing spanning two buckets is listed in both; visit it once.
    let mut seen = HashSet::new();
    for bx in x0..=x1 {
        for bz in z0..=z1 {
            if let Some(list) = cells.get(&key(bx, bz)) {
                for &i in list {
                    if seen.insert(i) {
                        out.push(i);
                    }
                }
            }
        }
    }
}

impl ColliderIndex {
    pub fn new(obstacles: Vec<Obstacle>, boxes: Vec<BoxCollider>, decks: Vec<Deck>) -> Self {
        let mut idx = ColliderIndex { obstacles, boxes, decks, ..Default::default() };
        for i in 0..idx.obstacles.len() {
            let o = idx.obstacles[i];
            insert(&mut idx.obstacle_cells, o.x, o.z, o.r, i);
        }
        for i in 0..idx.boxes.len() {
            let b = idx.boxes[i];
            insert(&mut idx.box_cells, b.x, b.z, b.hw.hypot(b.hd), i);
        }
        for i in 0..idx.decks.len() {
            let d = idx.decks[i];
            insert(&mut idx.deck_cells, d.x, d.z, d.hw.hypot(d.hd), i);
        }
        idx
    }

    /// Adds a box after the fact (a house that just got its walls). Returns its index.
    pub fn add_box(&mut self, b: BoxCollider) -> usize {
        self.boxes.push(b);
        let i = self.boxes.len() - 1;
        insert(&mut self.box_cells, b.x, b.z, b.hw.hypot(b.hd), i);
        i
    }

    pub fn add_deck(&mut self, d: Deck) -> usize {
        self.decks.push(d);
        let i = self.decks.len() - 1;
        insert(&mut self.deck_cells, d.x, d.z, d.hw.hypot(d.hd), i);
        i
    }

    pub fn add_obstacle(&mut self, o: Obstacle) -> usize {
        self.obstacles.push(o);
        let i = self.obstacles.len() - 1;
        insert(&mut self.obstacle_cells, o.x, o.z, o.r, i);
        i
    }

    /// Disables a box without reshuffling indices (a demolished wall).
    pub fn remove_box(&mut self, i: usize) {
        if let Some(b) = self.boxes.get_mut(i) {
            b.top = f64::NEG_INFINITY;
        }
    }

    pub fn remove_obstacle(&mut self, i: usize) {
        if let Some(o) = self.obstacles.get_mut(i) {
            o.r = 0.0;
        }
    }

    pub fn each_obstacle(&self, x: f64, z: f64, r: f64, mut f: impl FnMut(&Obstacle)) {
        let mut ids = Vec::new();
        visit(&self.obstacle_cells, x, z, r, &mut ids);
        for i in ids {
            f(&self.obstacles[i]);
        }
    }

    pub fn each_box(&self, x: f64, z: f64, r: f64, mut f: impl FnMut(&BoxCollider)) {
        let mut ids = Vec::new();
        visit(&self.box_cells, x, z, r, &mut ids);
        for i in ids {
            f(&self.boxes[i]);
        }
    }

    pub fn each_deck(&self, x: f64, z: f64, r: f64, mut f: impl FnMut(&Deck)) {
        let mut ids = Vec::new();
        visit(&self.deck_cells, x, z, r, &mut ids);
        for i in ids {
            f(&self.decks[i]);
        }
    }
}

/// Is (x, z) inside a rectangle?
pub fn in_rect(b: &BoxCollider, x: f64, z: f64, pad: f64) -> bool {
    let (dx, dz) = (x - b.x, z - b.z);
    let lx = dx * b.cos - dz * b.sin;
    let lz = dx * b.sin + dz * b.cos;
    lx.abs() <= b.hw + pad && lz.abs() <= b.hd + pad
}

/// Pushes a circle out of a rectangle. Returns the push (world dx, dz), or None if not touching.
/// Works in the box's own frame: closest point on the box, then back out along the gap.
pub fn push_out_of_box(b: &BoxCollider, x: f64, z: f64, r: f64) -> Option<(f64, f64)> {
    let (dx, dz) = (x - b.x, z - b.z);
    let lx = dx * b.cos - dz * b.sin;
    let lz = dx * b.sin + dz * b.cos;
    let cx = (-b.hw).max(b.hw.min(lx));
    let cz = (-b.hd).max(b.hd.min(lz));
    let ox = lx - cx;
    let oz = lz - cz;
    let d2 = ox * ox + oz * oz;
    if d2 >= r * r {
        return None;
    }
    let (px, pz);
    if d2 > 1e-10 {
        let d = d2.sqrt();
        px = ox / d * (r - d);
        pz = oz / d * (r - d);
    } else {
        // Centre inside the box: leave by the nearest face.
        let ex = b.hw - lx.abs();
        let ez = b.hd - lz.abs();
        if ex < ez {
            px = (if lx >= 0.0 { 1.0 } else { -1.0 }) * (ex + r);
            pz = 0.0;
        } else {
            px = 0.0;
            pz = (if lz >= 0.0 { 1.0 } else { -1.0 }) * (ez + r);
        }
    }
    // Back to world: inverse of the rotation above.
    Some((px * b.cos + pz * b.sin, -px * b.sin + pz * b.cos))
}

/// The ground under a point for something whose feet are at `y`: the terrain, or a deck or a
/// box top it is standing on (anything at most `step_up` above its feet).
pub fn ground_at(hf: &Heightfield, index: &ColliderIndex, x: f64, z: f64, y: f64, step_up: f64) -> f64 {
    let mut g = hf.height(x, z);
    let reach = y + step_up;
    index.each_deck(x, z, 0.5, |d| {
        if d.top > g && d.top <= reach && in_rect(d, x, z, 0.0) {
            g = d.top;
        }
    });
    index.each_box(x, z, 0.5, |b| {
        if b.top > g && b.top <= reach && in_rect(b, x, z, 0.0) {
            g = b.top;
        }
    });
    g
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::zone::rect;

    #[test]
    fn a_circle_is_pushed_out_of_a_box_by_the_nearest_face() {
        let b = rect(0.0, 0.0, 2.0, 1.0, 0.0, 3.0);
        let (px, pz) = push_out_of_box(&b, 0.0, 0.9, 0.5).unwrap();
        assert!(px.abs() < 1e-12 && (pz - 0.6).abs() < 1e-9, "{px} {pz}");
        assert!(push_out_of_box(&b, 0.0, 2.0, 0.5).is_none());
    }

    #[test]
    fn something_in_two_buckets_is_visited_once() {
        let idx = ColliderIndex::new(vec![Obstacle { kind: super::super::zone::ObstacleKind::Rock, x: 16.0, z: 0.0, r: 3.0 }], vec![], vec![]);
        let mut n = 0;
        idx.each_obstacle(14.0, 0.0, 4.0, |_| n += 1);
        assert_eq!(n, 1);
    }
}
