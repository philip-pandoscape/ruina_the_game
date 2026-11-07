//! The world: regions placed on a grid of chunks (shared/world.json, built from
//! content/world.json), and the open sea wherever no region stands. Each region is a zone grown from
//! its recipe. Its recipe is written in world coordinates and its grid covers exactly its chunks
//! (contentc checks both), so a region is placed by where it is, never moved there. The rules ask the
//! ground through the map, so they work the same on any region and across their borders: how high it
//! is, how steep, what it's made of, how deep the water is over it, and where the edge of the world
//! is.
//!
//! Borders have no seam. Near a chunk's edge the ground is shared with what's across it, by weights
//! that step smoothly from one chunk to the next over `blend` metres either side and always sum to
//! one: the ground there is each neighbour's as its recipe grew it (a region's held at its edge past
//! it, the open sea's its floor), weighed together. Where every weight is one region's, its ground is
//! its own to the bit. A region bakes the blend into its grid as it grows, so what's drawn is what's
//! walked on; and since the ground at a point is the same sum whichever side works it out, two
//! regions' edges are the same heights. The open sea near a region slopes to meet it the same way.
//!
//! Regions grow by need and are dropped when nothing needs them. A map is a view of a world: it holds
//! the regions grown for whoever plays through it (`hold`: a server's simulation its chunks and a band
//! round them, the browser what's near the player), and every view of one world shares what's grown,
//! so a region is grown once however many views hold it, and let go when none does. What's across a
//! border reads only a region's edges as its recipe grew them, two vertices deep, and those are kept
//! for the world once grown (`Edges`), so a region's ground is the same to the bit grown alone, with
//! its neighbours, or again after being dropped. A view asked about ground it doesn't hold grows it
//! there and then (counted: `unheld`), as every view did before regions were dropped.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};

use serde::Deserialize;

use super::generate::{Generated, generate};
use super::noise::smoothstep;
use super::zone::{Heightfield, Recipe, Zone, surface};

mod built {
    include!(concat!(env!("OUT_DIR"), "/regions.rs"));
}

/// Where a region stands: its first chunk, and how many chunks it spans along x (`w`) and z (`d`).
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chunks {
    pub x: i32,
    pub z: i32,
    pub w: i32,
    pub d: i32,
}

impl Chunks {
    /// Whether the chunk (cx, cz) is one of these.
    pub fn has(&self, cx: i32, cz: i32) -> bool {
        cx >= self.x && cx < self.x + self.w && cz >= self.z && cz < self.z + self.d
    }

    /// The square they cover, in metres: (min x, min z, max x, max z).
    pub fn bounds(&self, chunk: f64) -> [f64; 4] {
        [self.x as f64 * chunk, self.z as f64 * chunk, (self.x + self.w) as f64 * chunk, (self.z + self.d) as f64 * chunk]
    }
}

#[derive(Deserialize)]
struct RegionFile {
    id: String,
    chunks: Chunks,
}

#[derive(Deserialize)]
struct Sea {
    level: f64,
    depth: f64,
}

#[derive(Deserialize)]
struct WorldFile {
    chunk: f64,
    blend: f64,
    sea: Sea,
    regions: Vec<RegionFile>,
}

/// One region of the world: where it stands and what it is, grown or not.
pub struct Region {
    pub id: String,
    pub chunks: Chunks,
    recipe: Recipe,
}

impl Region {
    /// What the region is: its places, people, plots and spots, as its recipe says, grown or not.
    pub fn recipe(&self) -> &Recipe {
        &self.recipe
    }
}

/// A grid's outer two rows and columns of vertices as its recipe grew it, before its borders were
/// blended: all that anything across its borders ever reads of it (a point outside its grid reads its
/// ground held at its edge, which is the last quad's, so the vertex one in too).
#[derive(Clone, Debug)]
pub struct Edges {
    pub cells: usize,
    pub n: usize,
    pub cell: f64,
    pub min_x: f64,
    pub min_z: f64,
    /// The two rows along each of the low and high z edges (full width), then for every row between,
    /// the two vertices at each end.
    heights: Vec<f32>,
}

/// How deep along each edge `Edges` keeps a grid's vertices.
const EDGE: usize = 2;

impl Edges {
    /// A grid's edges.
    pub fn of(hf: &Heightfield) -> Edges {
        let n = hf.n;
        let mut heights = Vec::with_capacity(Self::len_for(n));
        for j in 0..n {
            for i in 0..n {
                if Self::kept(n, i, j) {
                    heights.push(hf.heights()[j * n + i]);
                }
            }
        }
        Edges { cells: hf.cells, n, cell: hf.cell, min_x: hf.min_x, min_z: hf.min_z, heights }
    }

    /// Edges as another engine kept them (`heights`, in the order `heights()` gives them), for a grid
    /// `cells` across at (min x, min z); None if there aren't as many as such a grid's edges have.
    pub fn from_parts(cells: usize, cell: f64, min_x: f64, min_z: f64, heights: Vec<f32>) -> Option<Edges> {
        let n = cells + 1;
        (heights.len() == Self::len_for(n)).then_some(Edges { cells, n, cell, min_x, min_z, heights })
    }

    fn len_for(n: usize) -> usize {
        (0..n).map(|j| (0..n).filter(|&i| Self::kept(n, i, j)).count()).sum()
    }

    /// Whether vertex (i, j) of a grid `n` vertices a side is one of its edges'.
    fn kept(n: usize, i: usize, j: usize) -> bool {
        i < EDGE || j < EDGE || i + EDGE >= n || j + EDGE >= n
    }

    /// The heights kept, row by row.
    pub fn heights(&self) -> &[f32] {
        &self.heights
    }

    fn at(&self, i: usize, j: usize) -> f64 {
        let n = self.n;
        debug_assert!(Self::kept(n, i, j), "({i}, {j}) isn't on a grid's edge");
        let full = 2 * EDGE >= n;
        let k = if full || j < EDGE {
            j * n + i
        } else if j + EDGE >= n {
            EDGE * n + (n - 2 * EDGE) * 2 * EDGE + (j + EDGE - n) * n + i
        } else {
            EDGE * n + (j - EDGE) * 2 * EDGE + if i < EDGE { i } else { EDGE + i + EDGE - n }
        };
        f64::from(self.heights[k])
    }

    fn max_x(&self) -> f64 {
        self.min_x + self.cells as f64 * self.cell
    }

    fn max_z(&self) -> f64 {
        self.min_z + self.cells as f64 * self.cell
    }

    /// The grid's ground at a point held to its edges, as `vertex_or_height` reads a whole grid.
    fn held_at_edge(&self, x: f64, z: f64) -> f64 {
        let x = x.clamp(self.min_x, self.max_x());
        let z = z.clamp(self.min_z, self.max_z());
        let (gx, gz) = ((x - self.min_x) / self.cell, (z - self.min_z) / self.cell);
        if gx == gx.floor() && gz == gz.floor() {
            return self.at(gx as usize, gz as usize);
        }
        // Heightfield::height's quad and triangles, to the bit.
        let last = self.cells as f64 - 1e-6;
        let gx = if gx < 0.0 {
            0.0
        } else if gx > last {
            last
        } else {
            gx
        };
        let gz = if gz < 0.0 {
            0.0
        } else if gz > last {
            last
        } else {
            gz
        };
        let (i, j) = (gx.floor() as usize, gz.floor() as usize);
        let (fx, fz) = (gx - i as f64, gz - j as f64);
        let (a, b, cc, d) = (self.at(i, j), self.at(i + 1, j), self.at(i, j + 1), self.at(i + 1, j + 1));
        if fx >= fz { a + (b - a) * fx + (d - b) * fz } else { a + (cc - a) * fz + (d - cc) * fx }
    }
}

/// A region grown: its zone (its ground blended along its borders, what's solid on it), and its
/// edges as its recipe grew them.
pub struct Grown {
    pub zone: Zone,
    edges: Arc<Edges>,
}

impl Grown {
    /// A region grown elsewhere (the browser's worker grows them and hands them to the page): its
    /// zone, and its edges as its recipe grew them.
    pub fn of(zone: Zone, edges: Edges) -> Grown {
        Grown { zone, edges: Arc::new(edges) }
    }

    /// Its edges as its recipe grew them, before its borders were blended.
    pub fn edges(&self) -> &Edges {
        &self.edges
    }
}

/// What every view of one world shares: what's grown of each region (held while any view holds it),
/// and each region's edges once grown (kept for the world: a few kilobytes, and a neighbour growing
/// later reads them).
struct Shared {
    grown: Vec<Weak<Grown>>,
    edges: Vec<Option<Arc<Edges>>>,
    /// How many times a region has been grown, by its place (the tests count them).
    grows: Vec<u32>,
}

/// One world: its regions, where they stand, and what's grown of them.
struct World {
    regions: Vec<Region>,
    by_chunk: BTreeMap<(i32, i32), usize>,
    /// The edge of the world: every region's chunks together, as (min x, min z, max x, max z).
    bounds: [f64; 4],
    shared: Mutex<Shared>,
}

/// Whose ground: a region's, by its place in the map, or the open sea's (None).
type Owner = Option<usize>;

/// A view of a world: its regions and the sea between them, answering the ground anywhere in it, and
/// holding the regions grown for whoever plays through it.
pub struct WorldMap {
    /// Metres a chunk is on a side.
    pub chunk: f64,
    /// Sea level, the same everywhere.
    pub water: f64,
    /// The open sea's floor, where no region stands.
    pub sea_floor: f64,
    /// Metres either side of a chunk's edge over which the ground is shared with what's across it.
    pub blend: f64,
    world: Arc<World>,
    /// Each region's grown zone while this view holds it.
    held: Vec<OnceLock<Arc<Grown>>>,
    /// Regions grown because something asked about ground this view didn't hold.
    unheld: AtomicU32,
}

impl Clone for WorldMap {
    /// Another view of the same world, holding what this one holds.
    fn clone(&self) -> Self {
        WorldMap {
            chunk: self.chunk,
            water: self.water,
            sea_floor: self.sea_floor,
            blend: self.blend,
            world: self.world.clone(),
            held: self.held.clone(),
            unheld: AtomicU32::new(self.unheld.load(Ordering::Relaxed)),
        }
    }
}

impl WorldMap {
    /// A world from its file (shared/world.json's shape), each region's recipe found by `recipe`.
    pub fn from_json(text: &str, recipe: impl Fn(&str) -> Option<Recipe>) -> Result<WorldMap, String> {
        let file: WorldFile = serde_json::from_str(text).map_err(|e| format!("not a world: {e}"))?;
        let mut regions = Vec::new();
        let mut by_chunk = BTreeMap::new();
        let mut bounds = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for (i, r) in file.regions.into_iter().enumerate() {
            let rec = recipe(&r.id).ok_or_else(|| format!("no zone {:?} for the world's region", r.id))?;
            let c = r.chunks;
            for cx in c.x..c.x + c.w {
                for cz in c.z..c.z + c.d {
                    if by_chunk.insert((cx, cz), i).is_some() {
                        return Err(format!("{}: chunk ({cx}, {cz}) is another region's", r.id));
                    }
                }
            }
            let b = c.bounds(file.chunk);
            bounds = [bounds[0].min(b[0]), bounds[1].min(b[1]), bounds[2].max(b[2]), bounds[3].max(b[3])];
            regions.push(Region { id: r.id, chunks: c, recipe: rec });
        }
        if regions.is_empty() {
            return Err("a world has at least one region".into());
        }
        if !(file.blend >= 0.0 && file.blend <= file.chunk / 2.0) {
            return Err(format!("blend {} isn't between 0 and half a chunk", file.blend));
        }
        Ok(Self::of(World::new(regions, by_chunk, bounds), file.chunk, file.sea.level, file.sea.level - file.sea.depth, file.blend))
    }

    fn of(world: World, chunk: f64, water: f64, sea_floor: f64, blend: f64) -> WorldMap {
        let held = (0..world.regions.len()).map(|_| OnceLock::new()).collect();
        WorldMap { chunk, water, sea_floor, blend, world: Arc::new(world), held, unheld: AtomicU32::new(0) }
    }

    /// A space with no regions in it, an instance's: nothing under its own floors but a fall to
    /// `floor`, no sea, and its edge at `bounds` (min x, min z, max x, max z).
    pub fn void(bounds: [f64; 4], floor: f64) -> WorldMap {
        Self::of(World::new(Vec::new(), BTreeMap::new(), bounds), 256.0, floor - 1.0, floor, 0.0)
    }

    /// Another view of the same world, holding nothing yet: what it holds is its own to grow and
    /// drop, and what any view of the world has grown it shares.
    pub fn view(&self) -> WorldMap {
        Self { held: (0..self.held.len()).map(|_| OnceLock::new()).collect(), unheld: AtomicU32::new(0), ..self.clone() }
    }

    pub fn regions(&self) -> &[Region] {
        &self.world.regions
    }

    /// Every region's recipe: the places, people, plots and spots in this world, wherever they are.
    pub fn recipes(&self) -> impl Iterator<Item = &Recipe> {
        self.world.regions.iter().map(Region::recipe)
    }

    pub fn region(&self, id: &str) -> Option<&Region> {
        self.world.regions.iter().find(|r| r.id == id)
    }

    /// A region's place in the map, by its id.
    pub fn place_of(&self, id: &str) -> Option<usize> {
        self.world.regions.iter().position(|r| r.id == id)
    }

    /// The chunk a point is in.
    pub fn chunk_of(&self, x: f64, z: f64) -> (i32, i32) {
        ((x / self.chunk).floor() as i32, (z / self.chunk).floor() as i32)
    }

    /// The region a point is in, if any (the open sea is in none).
    pub fn region_at(&self, x: f64, z: f64) -> Option<&Region> {
        self.world.by_chunk.get(&self.chunk_of(x, z)).map(|&i| &self.world.regions[i])
    }

    /// The zone of the region a point is in, grown if this view doesn't hold it.
    pub fn zone_at(&self, x: f64, z: f64) -> Option<&Zone> {
        let &i = self.world.by_chunk.get(&self.chunk_of(x, z))?;
        Some(&self.grown(i).zone)
    }

    /// A region's zone: its ground, colliders and recipe, its ground along its borders blended with
    /// what's across them; grown if this view doesn't hold it (and held from then on).
    pub fn zone<'a>(&'a self, r: &'a Region) -> &'a Zone {
        &self.grown(self.index_of(r)).zone
    }

    /// The region at `i` as this view holds it: grown (or shared) and held if it wasn't, which counts
    /// as ground asked for that wasn't held.
    fn grown(&self, i: usize) -> &Arc<Grown> {
        self.held[i].get_or_init(|| {
            self.unheld.fetch_add(1, Ordering::Relaxed);
            self.share_or_grow(i)
        })
    }

    /// The region at `i` as some view of the world has it grown, or grown now.
    fn share_or_grow(&self, i: usize) -> Arc<Grown> {
        let mut shared = self.world.lock();
        if let Some(g) = shared.grown[i].upgrade() {
            return g;
        }
        let g = Arc::new(self.grow_region(i, &mut shared));
        shared.grown[i] = Arc::downgrade(&g);
        g
    }

    /// Grows the region at `i` from its recipe and blends its borders: its neighbours' edges as their
    /// recipes grew them, from the world's keeping, or grown for them now.
    fn grow_region(&self, i: usize, shared: &mut Shared) -> Grown {
        let r = &self.world.regions[i];
        let mut g = generate(&r.recipe);
        shared.grows[i] += 1;
        let raw = g.terrain.clone();
        let edges = Arc::new(Edges::of(&raw));
        shared.edges[i] = Some(edges.clone());
        let others = self.edges_around(i, shared);
        self.blend_borders(i, &raw, &mut g.terrain, &|j| &others[&j]);
        Grown { zone: Zone::of(r.recipe.clone(), g), edges }
    }

    /// The edges of every region beside (or diagonally beside) the one at `i`, as their recipes grew
    /// them: the world's, or grown for them now and kept.
    fn edges_around(&self, i: usize, shared: &mut Shared) -> BTreeMap<usize, Arc<Edges>> {
        let mut out = BTreeMap::new();
        for j in self.neighbours(i) {
            let e = match &shared.edges[j] {
                Some(e) => e.clone(),
                None => {
                    shared.grows[j] += 1;
                    let e = Arc::new(Edges::of(&generate(&self.world.regions[j].recipe).terrain));
                    shared.edges[j] = Some(e.clone());
                    e
                }
            };
            out.insert(j, e);
        }
        out
    }

    /// The regions standing on a chunk beside (or diagonally beside) one of the region at `i`'s.
    fn neighbours(&self, i: usize) -> Vec<usize> {
        let c = self.world.regions[i].chunks;
        let mut out: Vec<usize> = (c.x - 1..=c.x + c.w)
            .flat_map(|cx| (c.z - 1..=c.z + c.d).filter_map(move |cz| self.world.by_chunk.get(&(cx, cz)).copied()))
            .filter(|&j| j != i)
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// The region at `i` grown whole, as a worker grows it to hand over (the browser's,
    /// src/engine/world/grower.ts): everything its recipe grows, its borders blended (what's drawn,
    /// and what the rules walk on once it's adopted: `Zone::of`), and its edges as its recipe grew
    /// them, kept for the world. Nothing holds it here.
    pub fn grow_whole(&self, i: usize) -> (Generated, Edges) {
        let r = &self.world.regions[i];
        let mut g = generate(&r.recipe);
        let raw = g.terrain.clone();
        let edges = Edges::of(&raw);
        let others = {
            let mut shared = self.world.lock();
            shared.grows[i] += 1;
            shared.edges[i].get_or_insert_with(|| Arc::new(edges.clone()));
            self.edges_around(i, &mut shared)
        };
        self.blend_borders(i, &raw, &mut g.terrain, &|j| &others[&j]);
        (g, edges)
    }

    /// What a zone's recipe grows, its ground blended along its borders where this world places it
    /// (if it's one of its regions): what the browser draws, the same ground the rules walk on.
    pub fn generate(&self, recipe: &Recipe) -> Generated {
        let mut g = generate(recipe);
        if let Some(i) = self.world.regions.iter().position(|r| r.id == recipe.id) {
            let others = {
                let mut shared = self.world.lock();
                self.edges_around(i, &mut shared)
            };
            let raw = g.terrain.clone();
            self.blend_borders(i, &raw, &mut g.terrain, &|j| &others[&j]);
        }
        g
    }

    fn index_of(&self, r: &Region) -> usize {
        self.world.regions.iter().position(|o| std::ptr::eq(o, r)).expect("a region of this map")
    }

    // ---------- Growing and dropping by need ----------

    /// Whether this view holds the region at `i` grown.
    pub fn holds(&self, i: usize) -> bool {
        self.held.get(i).is_some_and(|h| h.get().is_some())
    }

    /// The places of the regions this view holds, in the map's order.
    pub fn held(&self) -> Vec<usize> {
        (0..self.held.len()).filter(|&i| self.holds(i)).collect()
    }

    /// The region at `i` as this view holds it, if it does.
    pub fn held_region(&self, i: usize) -> Option<&Grown> {
        self.held.get(i).and_then(OnceLock::get).map(|g| &**g)
    }

    /// Holds exactly the regions at `want` (places in the map): those it doesn't hold grown (or shared
    /// from another view of the world), the rest dropped. A region no view holds any more is freed.
    pub fn hold(&mut self, want: &[usize]) {
        for (i, h) in self.held.iter_mut().enumerate() {
            if !want.contains(&i) {
                h.take();
            }
        }
        for &i in want {
            if i < self.held.len() && self.held[i].get().is_none() {
                let g = self.share_or_grow(i);
                let _ = self.held[i].set(g);
            }
        }
    }

    /// Holds a region grown elsewhere (the browser's worker grows them): refused if it isn't the
    /// region at `i` as this world places it. One this view holds already is kept as it is.
    pub fn adopt(&mut self, i: usize, g: Grown) -> Result<(), String> {
        let Some(r) = self.world.regions.get(i) else { return Err(format!("no region at {i}")) };
        let (t, e) = (&g.zone.terrain, &g.edges);
        let want = &r.recipe.terrain;
        let [x0, z0, ..] = r.chunks.bounds(self.chunk);
        if g.zone.recipe.id != r.id
            || t.cells != want.cells
            || t.cell != want.cell
            || t.min_x != x0
            || t.min_z != z0
            || e.cells != t.cells
            || e.min_x != x0
            || e.min_z != z0
        {
            return Err(format!("not {} as the world places it", r.id));
        }
        if self.held[i].get().is_some() {
            return Ok(());
        }
        let mut shared = self.world.lock();
        let g = match shared.grown[i].upgrade() {
            Some(already) => already,
            None => {
                let g = Arc::new(g);
                shared.grown[i] = Arc::downgrade(&g);
                shared.edges[i].get_or_insert_with(|| g.edges.clone());
                g
            }
        };
        drop(shared);
        let _ = self.held[i].set(g);
        Ok(())
    }

    /// Lets the region at `i` go from this view.
    pub fn release(&mut self, i: usize) {
        if let Some(h) = self.held.get_mut(i) {
            h.take();
        }
    }

    /// The regions with a chunk within `reach` metres of a point, nearest first: what the browser
    /// grows round the player.
    pub fn near(&self, x: f64, z: f64, reach: f64) -> Vec<usize> {
        let mut out: Vec<(f64, usize)> = self
            .world
            .regions
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let [x0, z0, x1, z1] = r.chunks.bounds(self.chunk);
                let (dx, dz) = ((x0 - x).max(x - x1).max(0.0), (z0 - z).max(z - z1).max(0.0));
                ((dx * dx + dz * dz).sqrt(), i)
            })
            .filter(|&(d, _)| d <= reach)
            .collect();
        out.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        out.into_iter().map(|(_, i)| i).collect()
    }

    /// The regions standing on `chunks`, and those with a chunk nearer than `band` metres to one of
    /// them, in the map's order: what a simulation playing those chunks holds.
    pub fn around(&self, chunks: &[(i32, i32)], band: f64) -> Vec<usize> {
        let c = self.chunk;
        let reach = (band / c).ceil() as i32 + 1;
        let mut out: Vec<usize> = Vec::new();
        for &(cx, cz) in chunks {
            for dx in -reach..=reach {
                for dz in -reach..=reach {
                    // How far that chunk's square is from this one's: within the band if nearer than it.
                    let gap = |d: i32| (d.unsigned_abs().saturating_sub(1)) as f64 * c;
                    let (gx, gz) = (gap(dx), gap(dz));
                    if (dx, dz) != (0, 0) && (gx * gx + gz * gz).sqrt() >= band {
                        continue;
                    }
                    if let Some(&i) = self.world.by_chunk.get(&(cx + dx, cz + dz)) {
                        out.push(i);
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Every chunk a region stands on, in order.
    pub fn chunks(&self) -> Vec<(i32, i32)> {
        self.world.by_chunk.keys().copied().collect()
    }

    /// How many regions this view has grown because something asked about ground it didn't hold
    /// (a teleport, or a band too narrow): the browser's rules expect none.
    pub fn unheld(&self) -> u32 {
        self.unheld.load(Ordering::Relaxed)
    }

    /// How many times the region at `i` has been grown in this world, by any view (its edges grown
    /// alone for a neighbour count too).
    pub fn grows(&self, i: usize) -> u32 {
        self.world.lock().grows[i]
    }

    /// Grows every region this view doesn't hold, and holds them all (what's solid in a world is all
    /// its regions' colliders).
    pub fn grow_all(&self) {
        for (i, h) in self.held.iter().enumerate() {
            h.get_or_init(|| self.share_or_grow(i));
        }
    }

    // ---------- The ground ----------

    /// Who the ground at a point is shared between, and how much each has of it: up to four chunks'
    /// owners, each chunk's weight a smooth step across every chunk edge within `blend` of the point,
    /// the weights summing to one; an owner of several of the chunks has their weights together. In
    /// the order of their owners (the open sea first), so every side works the same sum.
    fn owners(&self, x: f64, z: f64) -> ([(Owner, f64); 4], usize) {
        let (cx, cz) = self.chunk_of(x, z);
        let (wx, wz) = (self.steps(x - cx as f64 * self.chunk), self.steps(z - cz as f64 * self.chunk));
        let mut out: [(Owner, f64); 4] = [(None, 0.0); 4];
        let mut n = 0;
        for &(dx, ax) in wx.iter().filter(|(_, w)| *w > 0.0) {
            for &(dz, az) in wz.iter().filter(|(_, w)| *w > 0.0) {
                let owner = self.world.by_chunk.get(&(cx + dx, cz + dz)).copied();
                let w = ax * az;
                match out[..n].iter_mut().find(|(o, _)| *o == owner) {
                    Some(slot) => slot.1 += w,
                    None => {
                        out[n] = (owner, w);
                        n += 1;
                    }
                }
            }
        }
        out[..n].sort_by_key(|(o, _)| o.map_or(0, |i| i + 1));
        (out, n)
    }

    /// Along one axis, a point `u` metres into its chunk: the weights of the chunk before it (-1),
    /// its own (0) and the one after it (1).
    fn steps(&self, u: f64) -> [(i32, f64); 3] {
        let b = self.blend;
        if b > 0.0 && u < b {
            let s = smoothstep(0.0, 1.0, (u + b) / (2.0 * b));
            [(-1, 1.0 - s), (0, s), (1, 0.0)]
        } else if b > 0.0 && u > self.chunk - b {
            let s = smoothstep(0.0, 1.0, (u - (self.chunk - b)) / (2.0 * b));
            [(-1, 0.0), (0, 1.0 - s), (1, s)]
        } else {
            [(-1, 0.0), (0, 1.0), (1, 0.0)]
        }
    }

    /// The ground at a point as its owners grew it, weighed together: the owner of the chunk it's in
    /// plus each other's share of the difference, so where they agree it's exactly theirs. `own` is
    /// the region working it out, with its own ground as grown (its grid holds the point); every
    /// other region's is read at its edges (`edges`).
    fn blended<'e>(&self, x: f64, z: f64, own: Option<(usize, &Heightfield)>, edges: &dyn Fn(usize) -> &'e Edges) -> f64 {
        let (owners, n) = self.owners(x, z);
        let at = |o: Owner| match (o, own) {
            (None, _) => self.sea_floor,
            (Some(i), Some((me, hf))) if i == me => vertex_or_height(hf, x, z),
            (Some(i), _) => edges(i).held_at_edge(x, z),
        };
        let base = self.world.by_chunk.get(&self.chunk_of(x, z)).copied();
        let h0 = at(base);
        let mut h = h0;
        for &(o, w) in &owners[..n] {
            if o != base {
                h += w * (at(o) - h0);
            }
        }
        h
    }

    /// Blends a region's ground along its borders, from `raw` (as grown) into `out`: whether any of it
    /// changed. Only a band `blend` wide round its grid can share its ground, as its chunks inside are
    /// all its own.
    fn blend_borders<'e>(&self, i: usize, raw: &Heightfield, out: &mut Heightfield, edges: &dyn Fn(usize) -> &'e Edges) -> bool {
        let band = (self.blend / raw.cell).ceil() as usize;
        let n = raw.n;
        let mut changed = false;
        for j in 0..n {
            for k in 0..n {
                if j > band && j + band < n - 1 && k > band && k + band < n - 1 {
                    continue;
                }
                let (x, z) = (raw.vx(k), raw.vz(j));
                if self.owners(x, z).1 < 2 {
                    continue;
                }
                let h = self.blended(x, z, Some((i, raw)), edges) as f32;
                let at = j * n + k;
                if h.to_bits() != out.heights()[at].to_bits() {
                    out.heights_mut()[at] = h;
                    changed = true;
                }
            }
        }
        changed
    }

    /// Ground height at a world point: a region's terrain, or the open sea's floor, sloping to meet
    /// any region within `blend` of it.
    pub fn height(&self, x: f64, z: f64) -> f64 {
        match self.zone_at(x, z) {
            Some(zn) => zn.terrain.height(x, z),
            None => self.sea_ground(x, z),
        }
    }

    /// The open sea's ground at a point: its floor, or blended with a region's near one.
    fn sea_ground(&self, x: f64, z: f64) -> f64 {
        if self.owners(x, z).1 < 2 { self.sea_floor } else { self.blended(x, z, None, &|j| &self.grown(j).edges) }
    }

    /// dh/dx and dh/dz of the ground under a point (the open sea's floor is flat but near a region).
    pub fn gradient(&self, x: f64, z: f64) -> (f64, f64) {
        if let Some(zn) = self.zone_at(x, z) {
            return zn.terrain.gradient(x, z);
        }
        if self.owners(x, z).1 < 2 {
            return (0.0, 0.0);
        }
        const E: f64 = 0.5;
        ((self.sea_ground(x + E, z) - self.sea_ground(x - E, z)) / (2.0 * E), (self.sea_ground(x, z + E) - self.sea_ground(x, z - E)) / (2.0 * E))
    }

    /// Steepness at a point: rise over run along the steepest direction of its ground.
    pub fn slope(&self, x: f64, z: f64) -> f64 {
        let (gx, gz) = self.gradient(x, z);
        (gx * gx + gz * gz).sqrt()
    }

    /// What the ground under a point is made of (the open sea's floor is sand).
    pub fn surface_at(&self, x: f64, z: f64) -> u8 {
        self.zone_at(x, z).map_or(surface::SAND, |zn| zn.terrain.surface_at(x, z))
    }

    /// How deep the water is over a point (0 on dry land).
    pub fn depth(&self, x: f64, z: f64) -> f64 {
        (self.water - self.height(x, z)).max(0.0)
    }

    /// Whether a point is within the edge of the world, `margin` metres in from it.
    pub fn inside(&self, x: f64, z: f64, margin: f64) -> bool {
        let [x0, z0, x1, z1] = self.world.bounds;
        x >= x0 + margin && x <= x1 - margin && z >= z0 + margin && z <= z1 - margin
    }

    /// A point brought back within the edge of the world, `margin` metres in from it.
    pub fn keep_inside(&self, x: f64, z: f64, margin: f64) -> (f64, f64) {
        let [x0, z0, x1, z1] = self.world.bounds;
        (x.clamp(x0 + margin, x1 - margin), z.clamp(z0 + margin, z1 - margin))
    }

    /// The edge of the world: (min x, min z, max x, max z).
    pub fn bounds(&self) -> [f64; 4] {
        self.world.bounds
    }
}

impl World {
    fn new(regions: Vec<Region>, by_chunk: BTreeMap<(i32, i32), usize>, bounds: [f64; 4]) -> World {
        let n = regions.len();
        let shared = Shared { grown: (0..n).map(|_| Weak::new()).collect(), edges: vec![None; n], grows: vec![0; n] };
        World { regions, by_chunk, bounds, shared: Mutex::new(shared) }
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A grid's height at a point held to its edges: a vertex's own height when the point is one (as it
/// is wherever two regions' grids meet: every region's cell is the same, a whole number to a
/// chunk), so both sides of a border read the same number.
fn vertex_or_height(hf: &Heightfield, x: f64, z: f64) -> f64 {
    let x = x.clamp(hf.min_x, hf.max_x());
    let z = z.clamp(hf.min_z, hf.max_z());
    let (gx, gz) = ((x - hf.min_x) / hf.cell, (z - hf.min_z) / hf.cell);
    if gx == gx.floor() && gz == gz.floor() { hf.heights()[gz as usize * hf.n + gx as usize] as f64 } else { hf.height(x, z) }
}

/// A region's recipe as built into the engine (shared/regions/<id>.json), or as given in its place or
/// beside them (crate::bundles), by its id.
pub fn region_recipe(id: &str) -> Option<Recipe> {
    let text = region_recipe_text(id)?;
    Some(serde_json::from_str(text).unwrap_or_else(|e| panic!("shared/regions/{id}.json is a region's recipe: {e}")))
}

/// A region's recipe as text, as `region_recipe` reads it: what the page reads of a region it's
/// handed (src/engine/world/grower.ts).
pub fn region_recipe_text(id: &str) -> Option<&'static str> {
    let path = format!("regions/{id}.json");
    match built::REGIONS.iter().find(|(z, _)| *z == id) {
        Some((_, compiled)) => Some(crate::bundles::bundle(&path, compiled)),
        None => crate::bundles::given(&path),
    }
}

/// The world (shared/world.json), each region grown the first time anything asks of this view, which
/// holds whatever it's asked about from then on. Whoever grows and drops regions by need plays through
/// a view of its own (`view`, `OpenWorld::playing`), sharing what's grown with this one.
pub fn world_map() -> &'static WorldMap {
    static W: OnceLock<WorldMap> = OnceLock::new();
    W.get_or_init(|| {
        let text = crate::bundles::bundle("world.json", include_str!("../../../../shared/world.json"));
        WorldMap::from_json(text, region_recipe).unwrap_or_else(|e| panic!("shared/world.json: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open::OpenWorld;

    #[test]
    fn emberholm_is_the_world_s_first_region_round_its_origin() {
        let w = world_map();
        let r = w.region_at(0.0, 0.0).expect("Emberholm stands at the origin");
        assert_eq!(r.id, "emberholm");
        assert_eq!(r.chunks, Chunks { x: -3, z: -3, w: 6, d: 6 });
        let t = &w.zone(r).terrain;
        // Its grid covers exactly its chunks.
        assert_eq!((t.min_x, t.min_z, t.max_x(), t.max_z()), (-768.0, -768.0, 768.0, 768.0));
        // Inside it, the ground is its terrain's, to the bit.
        for (x, z) in [(0.0, -264.0), (40.0, 110.0), (-262.5, 116.25), (700.0, -700.0)] {
            assert_eq!(w.height(x, z).to_bits(), t.height(x, z).to_bits());
            assert_eq!(w.surface_at(x, z), t.surface_at(x, z));
        }
    }

    #[test]
    fn past_every_region_is_open_sea_to_the_edge_of_the_world() {
        let w = world_map();
        assert!(w.region_at(800.0, 0.0).is_none());
        // Past the blend round Emberholm, the open sea's floor.
        assert_eq!(w.height(840.0, 0.0), w.sea_floor);
        assert_eq!(w.depth(840.0, 0.0), 30.0);
        assert_eq!(w.gradient(840.0, 0.0), (0.0, 0.0));
        assert!(w.inside(759.0, -759.0, 8.0));
        assert!(!w.inside(761.0, 0.0, 8.0));
        assert_eq!(w.keep_inside(900.0, -10.0, 8.0), (760.0, -10.0));
    }

    /// A world of two regions across the sea from each other: Emberholm, and to its west an islet two
    /// chunks across (x 1024 to 1536 m, z -256 to 256 m), its recipe written where it stands.
    fn archipelago() -> &'static WorldMap {
        static W: OnceLock<WorldMap> = OnceLock::new();
        W.get_or_init(|| {
            let file = r#"{ "chunk": 256, "blend": 64, "sea": { "level": 0, "depth": 30 }, "regions": [
                { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
                { "id": "islet", "chunks": { "x": 4, "z": -1, "w": 2, "d": 2 } } ] }"#;
            WorldMap::from_json(file, |id| if id == "islet" { Some(islet()) } else { region_recipe(id) }).expect("a world")
        })
    }

    fn islet() -> Recipe {
        small_region("islet", 7, 1280.0, 1280.0, 110.0, 6.0)
    }

    /// A region two chunks a side round (`mid`, 0), its landmass round (`land`, 0).
    fn small_region(id: &str, seed: u32, mid: f64, land: f64, radius: f64, hills: f64) -> Recipe {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "seed": seed, "climate": "temperate",
            "terrain": {
                "cells": 256, "cell": 2.0, "water": 0.0, "origin": [mid, 0.0],
                "landmass": { "x": land, "z": 0.0, "radius": radius, "lobes": [[3, 12.0, 0.4]], "warp": 10.0, "warpScale": 90.0 },
                "shore": { "beach": 20.0, "beachHeight": 2.0, "inlandRise": 0.02, "seabedSlope": 0.085, "seabedCurve": 0.00035, "maxDepth": 30.0 },
                "hills": { "scale": 120.0, "height": hills, "detailScale": 40.0, "detail": 1.0, "inlandFrom": 20.0, "inlandTo": 80.0 },
                "sandBelow": 1.6, "rockSlope": 1.2
            },
            "scatter": { "trees": 0.002, "rocks": 0.0005, "clearOfRoad": 5.0, "clearOfStructure": 4.0 },
            "spawn": { "x": land, "z": 0.0, "facing": 0.0 },
            "places": [], "npcs": [], "workbenches": [], "outposts": [], "housePlots": [], "nodes": [], "updrafts": [],
            "sky": { "dayLengthSeconds": 1800.0, "startHour": 8.5, "sunrise": 5.5, "sunset": 20.0 },
            "slimes": { "x": land, "z": 0.0, "count": 0, "r": 10.0 },
            "dummy": { "x": land + 10.0, "z": 0.0 }
        }))
        .expect("a small region's recipe")
    }

    const MAINLAND: &str = r#"{ "chunk": 256, "blend": 64, "sea": { "level": 0, "depth": 30 }, "regions": [
        { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
        { "id": "fells", "chunks": { "x": 4, "z": -1, "w": 2, "d": 2 } },
        { "id": "downs", "chunks": { "x": 6, "z": -1, "w": 2, "d": 2 } } ] }"#;

    fn mainland_recipe(id: &str) -> Option<Recipe> {
        match id {
            "fells" => Some(small_region("fells", 11, 1280.0, 1536.0, 190.0, 9.0)),
            "downs" => Some(small_region("downs", 23, 1792.0, 1536.0, 190.0, 3.0)),
            _ => region_recipe(id),
        }
    }

    /// Two regions across a land border at x = 1536 m: one landmass grown half by each, each half from
    /// its own recipe (its own seed and hills), so they differ where they meet until the border blends
    /// them.
    fn mainland() -> &'static WorldMap {
        static W: OnceLock<WorldMap> = OnceLock::new();
        W.get_or_init(|| WorldMap::from_json(MAINLAND, mainland_recipe).expect("a world"))
    }

    #[test]
    fn regions_across_a_land_border_meet_with_no_seam() {
        let w = mainland();
        let (fells, downs) = (&w.zone(w.region("fells").expect("fells")).terrain, &w.zone(w.region("downs").expect("downs")).terrain);
        assert_eq!((fells.max_x(), downs.min_x), (1536.0, 1536.0));
        // Grown alone, the two halves don't meet: their hills differ.
        let (raw_f, raw_d) = (
            generate(&small_region("fells", 11, 1280.0, 1536.0, 190.0, 9.0)).terrain,
            generate(&small_region("downs", 23, 1792.0, 1536.0, 190.0, 3.0)).terrain,
        );
        let n = fells.n;
        let apart = (0..n).map(|j| (raw_f.heights()[j * n + n - 1] - raw_d.heights()[j * n]).abs()).fold(0.0f32, f32::max);
        assert!(apart > 0.5, "the halves grown alone differ along the border by up to {apart} m");
        // Blended, the border's heights are the same numbers on both sides, all the way along.
        for j in 0..n {
            assert_eq!(fells.heights()[j * n + n - 1].to_bits(), downs.heights()[j * n].to_bits(), "row {j}");
        }
        // Walking over it, the ground never jumps.
        let mut last = w.height(1400.0, 0.0);
        let mut x = 1400.0;
        while x < 1680.0 {
            x += 0.25;
            let h = w.height(x, 0.0);
            assert!((h - last).abs() < 0.25, "a step of {} m at x = {x}", h - last);
            last = h;
        }
    }

    #[test]
    fn you_can_walk_from_one_region_into_the_next() {
        use crate::open::colliders::ground_at;
        use crate::open::step_player;
        use crate::player::{Actions, Build, Mode, Player};
        use crate::world::Spawn;
        let w = mainland();
        let world = OpenWorld::on(w, w.zone(w.region("fells").expect("fells")));
        let (x, z) = (1460.0, 0.0);
        let mut p = Player::new(Spawn { x, z, facing: std::f64::consts::FRAC_PI_2 }, 0, Build::default());
        p.pos.y = ground_at(w, &world.index, x, z, w.water, 1.2);
        assert!(w.height(x, z) > w.water && w.height(1620.0, 0.0) > w.water, "dry land either side of the border");
        let on = Actions { move_x: 1.0, ..Default::default() };
        for _ in 0..60 * 60 {
            step_player(&mut p, &on, &world, None, 0);
            assert!(p.mode != Mode::Swim, "never in the water: {:?}", p.pos);
            if p.pos.x > 1600.0 {
                break;
            }
        }
        assert_eq!(w.region_at(p.pos.x, p.pos.z).map(|r| r.id.as_str()), Some("downs"), "walked into the downs: {:?}", p.pos);
    }

    #[test]
    fn a_region_meets_the_open_sea_with_no_seam() {
        for (w, at) in [
            (world_map(), [(768.0, 0.0), (0.0, -768.0), (768.0, 768.0), (-768.0, 300.0)]),
            (archipelago(), [(1536.0, 10.0), (1024.0, -100.0), (1300.0, 256.0), (1536.0, -256.0)]),
        ] {
            for (x, z) in at {
                for (dx, dz) in [(1e-6, 0.0), (0.0, 1e-6), (1e-6, 1e-6)] {
                    let (a, b) = (w.height(x - dx, z - dz), w.height(x + dx, z + dz));
                    assert!((a - b).abs() < 1e-3, "at ({x}, {z}): {a} inside, {b} outside");
                }
            }
        }
    }

    #[test]
    fn a_region_s_ground_is_its_own_but_within_the_blend_of_its_edge() {
        let w = world_map();
        let blended = &w.zone(w.region("emberholm").expect("Emberholm")).terrain;
        let grown = generate(&region_recipe("emberholm").expect("Emberholm")).terrain;
        let n = grown.n;
        let band = (w.blend / grown.cell) as usize;
        let mut changed = 0;
        for j in 0..n {
            for k in 0..n {
                let (a, b) = (blended.heights()[j * n + k], grown.heights()[j * n + k]);
                if a.to_bits() != b.to_bits() {
                    changed += 1;
                    assert!(j <= band || k <= band || j >= n - 1 - band || k >= n - 1 - band, "({k}, {j}) is inside");
                }
            }
        }
        assert!(changed > 0, "Emberholm's edge is shallower than the open sea in places, and slopes to meet it");
        // The open sea's floor beyond it is where its edge was blended to.
        assert!((w.height(768.0, 0.0) - (grown.height(768.0, 0.0) + w.sea_floor) / 2.0).abs() < 1e-4);
    }

    #[test]
    fn regions_stand_where_the_world_puts_them_with_open_sea_between() {
        let w = archipelago();
        let islet = w.region_at(1280.0, 0.0).expect("the islet stands at its chunks");
        assert_eq!(islet.id, "islet");
        let t = &w.zone(islet).terrain;
        assert_eq!((t.min_x, t.min_z, t.max_x(), t.max_z()), (1024.0, -256.0, 1536.0, 256.0));
        assert!(w.height(1280.0, 0.0) > w.water, "its middle is dry land: {}", w.height(1280.0, 0.0));
        // Between the two, open sea.
        assert!(w.region_at(900.0, 0.0).is_none());
        assert_eq!(w.depth(900.0, 0.0), 30.0);
        // Emberholm is the same region in this world as in the main one.
        let e = w.zone(w.region("emberholm").expect("Emberholm"));
        assert_eq!(e.terrain.heights(), super::super::zone::emberholm().terrain.heights());
        // The edge of the world is round every region's chunks together, the sea between them included.
        assert!(w.inside(1500.0, 200.0, 8.0) && w.inside(1000.0, -700.0, 8.0));
        assert!(!w.inside(1530.0, 0.0, 8.0) && !w.inside(0.0, 765.0, 8.0));
    }

    #[test]
    fn a_world_of_regions_is_solid_with_all_of_them() {
        let w = archipelago();
        let world = OpenWorld::on(w, w.zone(w.region("emberholm").expect("Emberholm")));
        let count = |id: &str| w.zone(w.region(id).expect("a region")).obstacles.len();
        assert_eq!(world.index.obstacles.len(), count("emberholm") + count("islet"));
        assert!(count("islet") > 0, "the islet has its trees and rocks");
    }

    #[test]
    fn you_can_swim_from_one_region_to_the_next() {
        use crate::open::colliders::ground_at;
        use crate::open::step_player;
        use crate::player::{Actions, Build, Mode, Player};
        use crate::world::Spawn;
        let w = archipelago();
        let world = OpenWorld::on(w, w.zone(w.region("emberholm").expect("Emberholm")));
        // In the sea off Emberholm's west coast, swimming west for the islet.
        let (x, z) = (700.0, 0.0);
        let mut p = Player::new(Spawn { x, z, facing: std::f64::consts::FRAC_PI_2 }, 0, Build::default());
        p.pos.y = ground_at(w, &world.index, x, z, w.water, 1.2);
        let west = Actions { move_x: 1.0, ..Default::default() };
        let mut crossed = None;
        for i in 0..60 * 400 {
            step_player(&mut p, &west, &world, None, 0);
            if crossed.is_none() && w.region_at(p.pos.x, p.pos.z).is_some_and(|r| r.id == "islet") {
                crossed = Some(i);
            }
            if p.mode != Mode::Swim && crossed.is_some() {
                break;
            }
        }
        assert!(crossed.is_some(), "still at sea at {:?}, {:?}", p.pos, p.mode);
        assert!(p.pos.x > 1024.0 && p.mode != Mode::Swim, "ashore on the islet: {:?}, {:?}", p.pos, p.mode);
    }

    #[test]
    fn regions_may_not_share_a_chunk() {
        let file = r#"{ "chunk": 256, "blend": 64, "sea": { "level": 0, "depth": 30 }, "regions": [
            { "id": "emberholm", "chunks": { "x": -3, "z": -3, "w": 6, "d": 6 } },
            { "id": "emberholm", "chunks": { "x": 2, "z": 0, "w": 2, "d": 2 } } ] }"#;
        let e = WorldMap::from_json(file, region_recipe).err().expect("refused");
        assert!(e.contains("chunk (2, 0) is another region's"), "{e}");
    }

    // ---------- Growing and dropping by need ----------

    /// Every height, surface and collider of a grown zone, for holding two to each other to the bit.
    fn print(z: &Zone) -> (Vec<u32>, Vec<u8>, Vec<u8>, String) {
        let colliders = serde_json::to_string(&(&z.obstacles, &z.boxes, &z.decks)).expect("colliders");
        (z.terrain.heights().iter().map(|h| h.to_bits()).collect(), z.terrain.surface.clone(), z.clear.clone(), colliders)
    }

    /// The mainland world, fresh: nothing grown in it yet by any view.
    fn fresh_mainland() -> WorldMap {
        WorldMap::from_json(MAINLAND, mainland_recipe).expect("a world")
    }

    #[test]
    fn a_region_is_the_same_grown_alone_with_its_neighbours_or_again_after_being_dropped() {
        // Its neighbour first, then it: grown with what's across its border already grown.
        let mut together = fresh_mainland();
        let (fells, downs) = (together.place_of("fells").expect("fells"), together.place_of("downs").expect("downs"));
        together.hold(&[downs]);
        together.hold(&[downs, fells]);
        let with_neighbours = print(&together.held_region(fells).expect("held").zone);
        // Alone: nothing else of the world grown, its neighbour's edges grown for it.
        let mut alone = fresh_mainland();
        alone.hold(&[fells]);
        assert!(!alone.holds(downs), "only what was asked for is held");
        assert_eq!(print(&alone.held_region(fells).expect("held").zone), with_neighbours, "grown alone");
        // Dropped, and nothing else holding it: freed, and grown again from its recipe.
        let grown_before = alone.grows(fells);
        alone.hold(&[]);
        assert!(alone.held().is_empty());
        alone.hold(&[fells]);
        assert_eq!(alone.grows(fells), grown_before + 1, "grown again once it was let go");
        assert_eq!(print(&alone.held_region(fells).expect("held").zone), with_neighbours, "grown again after being dropped");
        // Its neighbour grown after it, with it dropped meanwhile: the same as grown beside it.
        let downs_beside = print(&together.held_region(downs).expect("held").zone);
        alone.hold(&[downs]);
        assert_eq!(print(&alone.held_region(downs).expect("held").zone), downs_beside, "its neighbour, grown after it was dropped");
        // And all of it the same as the world grown the first time anything asked, as before.
        let w = mainland();
        assert_eq!(print(w.zone(w.region("fells").expect("fells"))), with_neighbours);
    }

    #[test]
    fn views_of_one_world_share_what_s_grown_and_free_it_when_none_holds_it() {
        let world = fresh_mainland();
        let fells = world.place_of("fells").expect("fells");
        let (mut a, mut b) = (world.view(), world.view());
        a.hold(&[fells]);
        b.hold(&[fells]);
        assert_eq!(world.grows(fells), 1, "grown once for both");
        assert!(std::ptr::eq(a.held_region(fells).expect("a"), b.held_region(fells).expect("b")), "the same zone");
        // One lets it go: the other still has it, and nothing is grown again.
        a.hold(&[]);
        a.hold(&[fells]);
        assert_eq!(world.grows(fells), 1);
        // Both let it go: it's freed, and the next to need it grows it again.
        a.hold(&[]);
        b.hold(&[]);
        a.hold(&[fells]);
        assert_eq!(world.grows(fells), 2);
    }

    #[test]
    fn what_a_view_grows_by_need_is_near_what_it_plays() {
        let w = fresh_mainland();
        let (ember, fells, downs) = (w.place_of("emberholm").expect("e"), w.place_of("fells").expect("f"), w.place_of("downs").expect("d"));
        // Round a point: nearest first, as far as it reaches.
        assert_eq!(w.near(0.0, 0.0, 100.0), vec![ember]);
        assert_eq!(w.near(1100.0, 0.0, 300.0), vec![fells], "Emberholm's edge is 332 m off");
        assert_eq!(w.near(1100.0, 0.0, 400.0), vec![fells, ember]);
        assert_eq!(w.near(1100.0, 0.0, 600.0), vec![fells, ember, downs]);
        // A simulation's chunks and a band round them.
        assert_eq!(w.around(&[(4, 0)], 0.0), vec![fells]);
        assert_eq!(w.around(&[(5, 0)], 256.0), vec![fells, downs]);
        assert_eq!(w.around(&[(4, 0)], 256.0), vec![fells], "Emberholm is a chunk of sea away");
        assert_eq!(w.around(&[(4, 0)], 300.0), vec![ember, fells, downs], "both 256 m off");
        assert_eq!(w.around(&w.chunks(), 0.0), vec![ember, fells, downs]);
    }

    #[test]
    fn ground_asked_of_a_view_that_doesn_t_hold_it_is_grown_there_and_counted() {
        let mut w = fresh_mainland();
        let fells = w.place_of("fells").expect("fells");
        w.hold(&[fells]);
        let h = w.height(1300.0, 0.0);
        assert_eq!(w.unheld(), 0, "held: nothing grown to answer");
        // The downs aren't held: asked about, they're grown and held, and the view counts it.
        let d = w.height(1700.0, 0.0);
        assert_eq!(w.unheld(), 1);
        assert!(w.holds(w.place_of("downs").expect("downs")));
        assert_eq!(h.to_bits(), mainland().height(1300.0, 0.0).to_bits());
        assert_eq!(d.to_bits(), mainland().height(1700.0, 0.0).to_bits());
    }

    #[test]
    fn a_region_grown_elsewhere_is_held_as_it_was_grown() {
        // Grown in one world (the browser's worker), handed to another view of an identical world (the
        // page's rules), it answers the ground there as if grown there.
        let worker = fresh_mainland();
        let fells = worker.place_of("fells").expect("fells");
        let mut w = worker.view();
        w.hold(&[fells]);
        let g = w.held_region(fells).expect("held");
        let t = &g.zone.terrain;
        let terrain = Heightfield::from_parts(t.cells, t.cell, t.water, t.min_x, t.min_z, t.heights().to_vec(), t.surface.clone()).expect("a grid");
        let e = g.edges();
        let edges = Edges::from_parts(e.cells, e.cell, e.min_x, e.min_z, e.heights().to_vec()).expect("edges");
        let z = &g.zone;
        let zone = Zone {
            recipe: z.recipe.clone(),
            terrain,
            clear: z.clear.clone(),
            obstacles: z.obstacles.clone(),
            boxes: z.boxes.clone(),
            decks: z.decks.clone(),
            radius: z.radius,
        };
        let mut page = fresh_mainland();
        page.adopt(fells, Grown::of(zone, edges)).expect("taken");
        for (x, z) in [(1300.0, 10.0), (1530.0, -30.0), (1040.0, 250.0), (1000.0, 0.0), (1010.0, -270.0)] {
            assert_eq!(page.height(x, z).to_bits(), mainland().height(x, z).to_bits(), "at ({x}, {z})");
        }
        assert_eq!(page.unheld(), 0, "nothing grown to answer");
        assert_eq!(page.grows(fells), 0, "nothing grown in the page's world");
        // Not the region as this world places it: refused.
        let downs = page.place_of("downs").expect("downs");
        let g = w.held_region(fells).expect("held");
        let wrong = Zone::of(g.zone.recipe.clone(), generate(&g.zone.recipe));
        assert!(page.adopt(downs, Grown::of(wrong, Edges::of(&g.zone.terrain))).is_err());
    }

    #[test]
    fn a_grid_s_edges_answer_as_the_grid_does_from_outside_it() {
        let g = generate(&small_region("fells", 11, 1280.0, 1536.0, 190.0, 9.0)).terrain;
        let e = Edges::of(&g);
        let mut rng = crate::rng::Rng::new(5);
        for _ in 0..4000 {
            // Anywhere round it, outside or on its edge: held to its edges.
            let (x, z) = (1024.0 - 80.0 + rng.next_f64() * 672.0, -256.0 - 80.0 + rng.next_f64() * 672.0);
            if g.inside(x, z, 0.0) && x > 1025.0 && x < 1535.0 && z > -255.0 && z < 255.0 {
                continue;
            }
            assert_eq!(e.held_at_edge(x, z).to_bits(), vertex_or_height(&g, x, z).to_bits(), "at ({x}, {z})");
        }
        // Vertices on the edges exactly, corners too.
        for (x, z) in [(1024.0, -256.0), (1536.0, 256.0), (1024.0, 0.0), (1300.0, 256.0), (1536.0, 2.0)] {
            assert_eq!(e.held_at_edge(x, z).to_bits(), vertex_or_height(&g, x, z).to_bits(), "at ({x}, {z})");
        }
    }
}
