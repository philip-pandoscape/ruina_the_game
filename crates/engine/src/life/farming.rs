//! Scarecrow plots and what grows in them (the page reads them through src/engine/life/farming.ts).
//! A scarecrow claims an 8 x 8 m
//! patch of open, level ground (up to three); each of its 2 m cells holds one plant, which grows in
//! real time - faster in its own climate, faster again when watered or rained on - whether or not
//! you are watching.

use super::content::{CropDef, Rare, climate_factor, crop_def, farm, item_def};
use super::livestock::step_animal;
use super::state::{Plant, Scarecrow};
use super::weather::raining;
use super::{Life, LifeEvent, QuestEvent};
use crate::jsmath::{js_hypot, js_max, js_min};
use crate::open::zone::{Obstacle, ObstacleKind, surface, to_local, to_world};
use crate::open::{OpenWorld, Sim};

/// Half the plot's side (TS HALF).
fn half() -> f64 {
    (farm().scarecrow_cells as f64 * farm().cell) / 2.0
}

/// A number the way JavaScript tests it in an `if`: anything but 0 and NaN.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// The crop's produce, if it has any (TS `def.produce`, which is null for timber trees).
fn produce_of(def: &CropDef) -> Option<&str> {
    def.produce.as_deref().filter(|p| !p.is_empty())
}

/// Index of the scarecrow with this id in life.state.scarecrows.
pub fn scarecrow_index(life: &Life, id: i64) -> Option<usize> {
    life.state.scarecrows.iter().position(|s| s.id == id)
}

/// The plant in cell `idx` of the scarecrow with id `sc`, if there is one.
pub fn plant_at(life: &Life, sc: i64, idx: usize) -> Option<&Plant> {
    let i = scarecrow_index(life, sc)?;
    life.state.scarecrows[i].cells.get(idx)?.as_ref()
}

pub fn plant_at_mut(life: &mut Life, sc: i64, idx: usize) -> Option<&mut Plant> {
    let i = scarecrow_index(life, sc)?;
    life.state.scarecrows[i].cells.get_mut(idx)?.as_mut()
}

pub fn stage_of(p: &Plant) -> i64 {
    if p.is_animal() {
        return if p.growth >= 1.0 { 1 } else { 0 };
    }
    let def = crop_def(&p.crop);
    if p.growth >= 1.0 {
        return def.stages - 1;
    }
    (def.stages - 2).min((p.growth * (def.stages - 1) as f64).floor() as i64)
}

pub fn is_ripe(p: &Plant) -> bool {
    p.growth >= 1.0
}

/// Growth per second for a plant, given whether it is raining and the zone's climate.
fn rate(p: &Plant, rain: bool, climate: &str) -> f64 {
    let def = crop_def(&p.crop);
    let wet = if p.watered || rain { farm().water.boost } else { 1.0 };
    let climate = climate_factor(def, climate);
    // A picked fruit tree only has its last stretch to regrow, at its own pace.
    if let Some(regrow) = def.regrow_seconds.filter(|r| p.picked && truthy(*r)) {
        return (wet * climate) / (def.stages - 1) as f64 / regrow;
    }
    (wet * climate) / def.grow_seconds
}

/// Growth per second right now.
pub fn growth_rate(life: &Life, p: &Plant) -> f64 {
    rate(p, raining(life), &life.zone.recipe.climate)
}

/// Seconds until ripe at the current rate (an estimate: rain comes and goes).
pub fn seconds_to_ripe(life: &Life, p: &Plant) -> f64 {
    if p.growth >= 1.0 {
        return 0.0;
    }
    if p.is_animal() {
        return 0.0;
    }
    (1.0 - p.growth) / js_max(1e-6, growth_rate(life, p))
}

pub fn step_farms(life: &mut Life, dt: f64) {
    // Nothing a step changes here moves the rain or the clock, so they are read once.
    let rain = raining(life);
    let climate = life.zone.recipe.climate.as_str();
    let clock = life.state.clock;
    let mut changed = 0;
    for sc in life.state.scarecrows.iter_mut() {
        for p in sc.cells.iter_mut().flatten() {
            if p.is_animal() {
                if step_animal(clock, p, dt) {
                    changed += 1;
                }
                continue;
            }
            if p.growth >= 1.0 {
                continue;
            }
            let before = stage_of(p);
            p.growth = js_min(1.0, p.growth + rate(p, rain, climate) * dt);
            if stage_of(p) != before {
                p.watered = false; // each stage wants watering afresh
                changed += 1;
            }
        }
    }
    life.revision += changed;
}

/// Advances every plant by a long stretch at once (time away, or the dev panel's warp).
pub fn grow_for(life: &mut Life, seconds: f64) {
    let rain = raining(life);
    let climate = life.zone.recipe.climate.as_str();
    let clock = life.state.clock;
    for sc in life.state.scarecrows.iter_mut() {
        for p in sc.cells.iter_mut().flatten() {
            if p.is_animal() {
                step_animal(clock, p, seconds);
                continue;
            }
            if p.growth >= 1.0 {
                continue;
            }
            p.growth = js_min(1.0, p.growth + rate(p, rain, climate) * seconds);
            p.watered = false;
        }
    }
    life.revision += 1;
}

// ---------- Geometry ----------

/// The middle of a plot cell: (x, z).
pub fn cell_centre(sc: &Scarecrow, idx: usize) -> (f64, f64) {
    let n = farm().scarecrow_cells as f64;
    let i = idx as f64;
    let col = i % n;
    let row = (i / n).floor();
    let cell = farm().cell;
    let (ox, oz) = to_world((col - (n - 1.0) / 2.0) * cell, (row - (n - 1.0) / 2.0) * cell, sc.rot);
    (sc.x + ox, sc.z + oz)
}

/// The plot cell under a point, if any: (index into life.state.scarecrows, cell index).
pub fn cell_at(life: &Life, x: f64, z: f64) -> Option<(usize, usize)> {
    let n = farm().scarecrow_cells as f64;
    let half = half();
    for (k, sc) in life.state.scarecrows.iter().enumerate() {
        let (lx, lz) = to_local(x - sc.x, z - sc.z, sc.rot);
        if lx.abs() >= half || lz.abs() >= half {
            continue;
        }
        let col = (lx / farm().cell + n / 2.0).floor();
        let row = (lz / farm().cell + n / 2.0).floor();
        return Some((k, (row * n + col) as usize));
    }
    None
}

/// Where the scarecrow itself stands: just outside the plot's front-left corner.
pub fn scarecrow_post(x: f64, z: f64, rot: f64) -> (f64, f64) {
    let half = half();
    let (ox, oz) = to_world(half + 0.6, half + 0.6, rot);
    (x + ox, z + oz)
}

/// Why a scarecrow cannot go here, or None if it can.
pub fn plot_problem(life: &Life, sim: &Sim, x: f64, z: f64, rot: f64) -> Option<String> {
    let hf = sim.terrain();
    let s = &life.state;
    let max = farm().max_scarecrows;
    if s.scarecrows.len() >= max {
        return Some(format!("You already have {max} plots"));
    }
    let half = half();
    let clear = &sim.world.clear;
    let grid = sim.world.grid();
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut a = -1.0;
    while a <= 1.0 {
        let mut b = -1.0;
        while b <= 1.0 {
            let (ox, oz) = to_world(a * half, b * half, rot);
            let px = x + ox;
            let pz = z + oz;
            if !hf.inside(px, pz, 4.0) {
                return Some("Too close to the edge of the world".into());
            }
            let h = hf.height(px, pz);
            if h < hf.water + 0.8 {
                return Some("Too close to the water".into());
            }
            lo = js_min(lo, h);
            hi = js_max(hi, h);
            if hf.slope(px, pz) > 0.32 {
                return Some("The ground is too steep".into());
            }
            let surf = hf.surface_at(px, pz);
            if surf != surface::GRASS && surf != surface::FOREST && surf != surface::SOIL {
                return Some(if surf == surface::ROAD || surf == surface::PLAZA { "Not on a road" } else { "The soil here is no good" }.into());
            }
            let (ci, cj) = grid.cell_of(px, pz);
            let k = cj * grid.cells as f64 + ci;
            if k >= 0.0 && clear.get(k as usize).is_some_and(|&c| c != 0) {
                return Some("Too close to a road or building".into());
            }
            b += 0.5;
        }
        a += 0.5;
    }
    if hi - lo > 1.3 {
        return Some("The ground is too uneven".into());
    }
    for other in &s.scarecrows {
        if js_hypot(other.x - x, other.z - z) < half * 2.0 + 1.0 {
            return Some("Overlaps another plot".into());
        }
    }
    for p in sim.world.map.recipes().flat_map(|r| &r.house_plots) {
        if js_hypot(p.x - x, p.z - z) < 15.0 {
            return Some("That is a house plot".into());
        }
    }
    let mut blocked = false;
    sim.world.index.each_obstacle(x, z, half * 1.45, |o| {
        if o.r > 0.0 && matches!(o.kind, ObstacleKind::Tree | ObstacleKind::Rock | ObstacleKind::Post) {
            let (lx, lz) = to_local(o.x - x, o.z - z, rot);
            if lx.abs() < half + o.r + 0.3 && lz.abs() < half + o.r + 0.3 {
                blocked = true;
            }
        }
    });
    if blocked {
        return Some("Trees or rocks in the way".into());
    }
    None
}

/// Puts a scarecrow down (the item is already paid for). Its post blocks like any other, once the
/// step that put it down is over (Life::make_solid). Returns its id.
pub fn add_scarecrow(life: &mut Life, _sim: &mut Sim, x: f64, z: f64, rot: f64) -> i64 {
    let n = farm().scarecrow_cells.max(0) as usize;
    let id = life.next_id();
    life.state.scarecrows.push(Scarecrow { id, x, z, rot, cells: vec![None; n * n] });
    life.revision += 1;
    id
}

/// Makes a scarecrow's post solid and its ground tilled (once per owner and scarecrow: a channel's
/// players share one world, and scarecrow ids are only unique per character, so it is remembered
/// under `owner`'s id).
pub fn add_scarecrow_collider(world: &mut OpenWorld, owner: i64, sc: &Scarecrow) {
    if !world.added.insert(format!("{owner}:sc{}", sc.id)) {
        return;
    }
    let (px, pz) = scarecrow_post(sc.x, sc.z, sc.rot);
    world.index.add_obstacle(Obstacle { kind: ObstacleKind::Post, x: px, z: pz, r: 0.25, scale: 1.0, rot: sc.rot });
    // Tilled ground: no grass, no new trees.
    let grid = world.grid();
    let half = half();
    let clear = &mut world.clear;
    let mut a = -half - 1.0;
    while a <= half + 1.0 {
        let mut b = -half - 1.0;
        while b <= half + 1.0 {
            let (ox, oz) = to_world(a, b, sc.rot);
            let (i, j) = grid.cell_of(sc.x + ox, sc.z + oz);
            let cells = grid.cells as f64;
            if i >= 0.0
                && j >= 0.0
                && i < cells
                && j < cells
                && let Some(c) = clear.get_mut(j as usize * grid.cells + i as usize)
            {
                *c = 1;
            }
            b += grid.cell / 2.0;
        }
        a += grid.cell / 2.0;
    }
}

// ---------- Actions on a cell ----------

/// Plants in cell `idx` of the scarecrow with id `sc`.
pub fn plant(life: &mut Life, sc: i64, idx: usize, seed_item: &str) -> bool {
    let def = item_def(seed_item);
    let Some(crop) = def.plants.as_deref().filter(|c| !c.is_empty()) else { return false };
    let Some(k) = scarecrow_index(life, sc) else { return false };
    // An empty cell (one past the end of the plot is nowhere to plant).
    if !matches!(life.state.scarecrows[k].cells.get(idx), Some(None)) {
        return false;
    }
    if !life.take(seed_item, 1) {
        life.toast(format!("No {} left", def.name), "bad");
        return false;
    }
    life.state.scarecrows[k].cells[idx] =
        Some(Plant { crop: crop.to_string(), growth: 0.0, watered: false, picked: false, animal: None, fed_until: None, produce: None });
    life.revision += 1;
    life.notify(QuestEvent { crop: Some(crop.to_string()), ..QuestEvent::new("plant") });
    true
}

/// Waters the plant in cell `idx` of the scarecrow with id `sc`.
pub fn water(life: &mut Life, sc: i64, idx: usize) -> bool {
    let Some(p) = plant_at(life, sc, idx) else { return false };
    if p.watered || p.growth >= 1.0 {
        return false;
    }
    if !life.afford(0.0, 0.0, farm().water.labor, "water") {
        return false;
    }
    if let Some(p) = plant_at_mut(life, sc, idx) {
        p.watered = true;
    }
    life.revision += 1;
    true
}

/// Harvests the ripe crop in cell `idx` of the scarecrow with id `sc`; `y` is where the effect is.
pub fn harvest(life: &mut Life, sc: i64, idx: usize, y: f64) -> bool {
    let Some(k) = scarecrow_index(life, sc) else { return false };
    let Some(p) = life.state.scarecrows[k].cells.get(idx).and_then(|c| c.as_ref()) else { return false };
    if p.growth < 1.0 {
        return false;
    }
    let def = crop_def(&p.crop);
    let Some(produce) = produce_of(def) else { return false };
    if !life.has_room(produce, def.yield_[1]) {
        life.toast("Your bag is full", "bad");
        return false;
    }
    if !life.afford(0.0, 0.0, def.harvest_labor, "harvest") {
        return false;
    }
    let n = life.rand_int(def.yield_[0], def.yield_[1]);
    life.give(produce, n, false);
    if def.seed_chance > 0.0 && life.rand() < def.seed_chance {
        life.give(&def.seed, 1, false);
    }
    let cell = &mut life.state.scarecrows[k].cells[idx];
    if def.regrow_seconds.is_some_and(truthy) {
        if let Some(p) = cell.as_mut() {
            p.picked = true;
            p.growth = (def.stages - 2) as f64 / (def.stages - 1) as f64;
        }
    } else {
        *cell = None;
    }
    life.state.stats.harvested += 1.0;
    life.revision += 1;
    let (cx, cz) = cell_centre(&life.state.scarecrows[k], idx);
    life.emit(LifeEvent::Harvest { x: cx, y, z: cz });
    life.notify(QuestEvent { crop: Some(def.id.clone()), ..QuestEvent::new("harvest") });
    true
}

/// Fells a grown tree for what its crop's `chop` gives - with a chance of something rare in it (a
/// log struck by lightning).
pub fn fell(life: &mut Life, sc: i64, idx: usize, y: f64) -> bool {
    let Some(k) = scarecrow_index(life, sc) else { return false };
    let Some(p) = life.state.scarecrows[k].cells.get(idx).and_then(|c| c.as_ref()) else { return false };
    let def = crop_def(&p.crop);
    let Some(chop) = def.chop.as_ref() else { return false };
    if stage_of(p) < def.stages - 2 {
        return false;
    }
    if !life.has_room(&chop.item, chop.yield_[1]) {
        life.toast("Your bag is full", "bad");
        return false;
    }
    if !life.afford(0.0, 0.0, chop.labor, "fell a tree") {
        return false;
    }
    let n = life.rand_int(chop.yield_[0], chop.yield_[1]);
    life.give(&chop.item, n, false);
    let (cx, cz) = cell_centre(&life.state.scarecrows[k], idx);
    if let Some(rare) = &chop.rare
        && life.rand() < rare.chance
    {
        find_rare(life, rare, cx, y, cz);
    }
    life.state.scarecrows[k].cells[idx] = None;
    life.revision += 1;
    life.emit(LifeEvent::Gather { x: cx, y, z: cz, kind: chop.kind.clone() });
    // Timber you grow counts for a step like "chop 10 lumber" as much as deadfall does.
    life.notify(QuestEvent { kind: Some(chop.kind.clone()), amount: Some(n as f64), ..QuestEvent::new("gather") });
    true
}

/// Something rare found where you felled or gathered: into your bag, with its toast and its effect there.
pub fn find_rare(life: &mut Life, rare: &Rare, x: f64, y: f64, z: f64) {
    life.give(&rare.item, 1, false);
    life.toast(rare.toast.as_str(), "coin");
    if rare.effect.as_deref() == Some("thunder") {
        life.emit(LifeEvent::Thunder { x, y, z });
    }
}

// The expected numbers here (yields, growth, positions, messages) are what the TypeScript copy of the
// rules gave for the same steps on the same island, while there was one.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::life::state::{QuestProgress, Stack};
    use crate::open::OpenWorld;
    use crate::open::zone::emberholm;
    use crate::player::{Build, Player};
    use crate::world::Spawn;

    /// A fresh island with no quest under way (so only the rules being tested speak up), the world
    /// it is on, and a player at the spawn.
    pub(crate) fn island() -> (Life, OpenWorld, Player) {
        let zone = emberholm();
        let mut life = Life::new(zone, None, None);
        life.state.quests = Default::default();
        life.drain_events();
        let s = zone.recipe.spawn;
        (life, OpenWorld::new(zone), Player::new(Spawn { x: s.x, z: s.z, facing: s.facing }, 0, Build::default()))
    }

    /// Stands the player on the ground at (x, z), facing `facing`.
    pub(crate) fn stand(sim: &mut Sim, x: f64, z: f64, facing: f64) {
        let y = sim.terrain().height(x, z);
        let p = &mut *sim.player;
        (p.pos.x, p.pos.y, p.pos.z, p.facing) = (x, y, z, facing);
    }

    /// Sets the island's random numbers so that the draw after the next `skip` comes up under
    /// `chance`: whatever is that rare is found.
    pub(crate) fn lucky(life: &mut Life, skip: usize, chance: f64) {
        life.state.rng = (0u32..)
            .find(|&seed| {
                let mut r = seed;
                for _ in 0..skip {
                    crate::rng::mulberry32(&mut r);
                }
                crate::rng::mulberry32(&mut r) < chance
            })
            .expect("a lucky seed");
    }

    /// The "+6 🌾 Barley" a bag gives when something goes in.
    pub(crate) fn got(n: i64, item: &str) -> LifeEvent {
        let def = item_def(item);
        LifeEvent::Toast { text: format!("+{n} {} {}", def.icon, def.name), kind: "good".into() }
    }

    fn crop(crop: &str, growth: f64) -> Plant {
        Plant { crop: crop.into(), growth, ..Default::default() }
    }

    fn stacks(list: &[(&str, i64)]) -> Vec<Stack> {
        list.iter().map(|&(item, n)| Stack { item: item.into(), n }).collect()
    }

    #[test]
    fn crops_pass_through_their_stages() {
        assert_eq!(stage_of(&crop("sunroot", 0.0)), 0);
        assert_eq!(stage_of(&crop("sunroot", 0.34)), 1);
        assert_eq!(stage_of(&crop("sunroot", 0.99)), 2);
        assert_eq!(stage_of(&crop("sunroot", 1.0)), 3);
        let chick = Plant { animal: Some(true), ..crop("chicken", 0.5) };
        assert_eq!(stage_of(&chick), 0);
        assert_eq!(stage_of(&Plant { growth: 1.0, ..chick }), 1);
        assert!(is_ripe(&crop("barley", 1.0)) && !is_ripe(&crop("barley", 0.999)));
    }

    #[test]
    fn growth_is_faster_watered_in_the_rain_and_in_its_own_climate() {
        let (mut life, _, _) = island();
        assert_eq!(growth_rate(&life, &crop("barley", 0.0)), 1.0 / 200.0);
        assert_eq!(growth_rate(&life, &Plant { watered: true, ..crop("barley", 0.0) }), 1.25 / 200.0);
        // Emberberries are a warm-climate plant: slower on temperate Emberholm.
        assert_eq!(growth_rate(&life, &crop("emberberry", 0.0)), 0.7 / 260.0);
        // A picked apple tree only regrows its fruit; a (frost-climate) pine has none to regrow.
        assert_eq!(growth_rate(&life, &Plant { picked: true, ..crop("apple", 0.0) }), 1.0 / 3.0 / 240.0);
        assert_eq!(growth_rate(&life, &Plant { picked: true, ..crop("pine", 0.0) }), 0.7 / 480.0);
        assert!((seconds_to_ripe(&life, &crop("barley", 0.5)) - 100.0).abs() < 1e-9);
        assert_eq!(seconds_to_ripe(&life, &crop("barley", 1.0)), 0.0);
        life.state.weather.rain_until = life.state.clock + 60.0;
        assert_eq!(growth_rate(&life, &crop("barley", 0.0)), 1.25 / 200.0);
    }

    #[test]
    fn a_plot_needs_open_level_ground_of_its_own() {
        let (mut life, mut world, mut p) = island();
        let sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        let at = |life: &Life, x: f64, z: f64| plot_problem(life, &sim, x, z, 0.0);
        assert_eq!(at(&life, -600.0, -420.0), None);
        assert_eq!(at(&life, -766.0, 0.0).as_deref(), Some("Too close to the edge of the world"));
        assert_eq!(at(&life, -760.0, -760.0).as_deref(), Some("Too close to the water"));
        assert_eq!(at(&life, -620.0, -420.0).as_deref(), Some("The soil here is no good"));
        assert_eq!(at(&life, -580.0, -440.0).as_deref(), Some("Trees or rocks in the way"));
        assert_eq!(at(&life, -580.0, -420.0).as_deref(), Some("Too close to a road or building"));
        assert_eq!(at(&life, -580.0, -400.0).as_deref(), Some("The ground is too uneven"));
        assert_eq!(at(&life, -540.0, -420.0).as_deref(), Some("Not on a road"));
        assert_eq!(at(&life, -180.0, -280.0).as_deref(), Some("The ground is too steep"));
        life.state.scarecrows.push(Scarecrow { id: 9, x: -208.0, z: -240.0, ..Default::default() });
        assert_eq!(at(&life, -208.0, -232.0).as_deref(), Some("Overlaps another plot"));
        life.state.scarecrows.push(Scarecrow { id: 10, ..Default::default() });
        life.state.scarecrows.push(Scarecrow { id: 11, ..Default::default() });
        assert_eq!(at(&life, -600.0, -420.0).as_deref(), Some("You already have 3 plots"));
    }

    #[test]
    fn a_scarecrow_post_is_solid_and_its_ground_tilled_once_per_owner() {
        let (mut life, mut world, mut p) = island();
        let before = world.index.obstacles.len();
        assert_eq!(plot_problem(&life, &Sim { player: &mut p, world: &world, owner: 1 }, -208.0, -240.0, 0.0), None);
        let id = add_scarecrow(&mut life, &mut Sim { player: &mut p, world: &world, owner: 1 }, -208.0, -240.0, 0.0);
        assert_eq!((id, life.state.scarecrows[0].cells.len()), (1, 16));
        assert_eq!(scarecrow_post(-208.0, -240.0, 0.0), (-203.4, -235.4));
        // The world is the same for everyone while they step: the post is solid once the step that
        // put it down is over.
        assert_eq!(world.index.obstacles.len(), before);
        life.make_solid(&mut world, 1);
        assert_eq!(world.index.obstacles.len(), before + 1);
        let post = world.index.obstacles[before];
        assert!(post.kind == ObstacleKind::Post && post.r == 0.25 && (post.x, post.z) == (-203.4, -235.4));
        // Tilled: no second plot goes on top of it.
        let sim = Sim { player: &mut p, world: &world, owner: 1 };
        assert_eq!(plot_problem(&life, &sim, -208.0, -240.0, 0.0).as_deref(), Some("Too close to a road or building"));
        // Everyone in a channel shares the world: the same post isn't added twice, but another
        // character's scarecrow with the same id is a post of its own.
        let sc = life.state.scarecrows[0].clone();
        add_scarecrow_collider(&mut world, 1, &sc);
        assert_eq!(world.index.obstacles.len(), before + 1);
        add_scarecrow_collider(&mut world, 2, &sc);
        assert_eq!(world.index.obstacles.len(), before + 2);
    }

    #[test]
    fn the_cells_of_a_plot() {
        let (mut life, _, _) = island();
        life.state.scarecrows.push(Scarecrow { id: 1, x: -208.0, z: -240.0, rot: 0.0, cells: vec![None; 16] });
        let sc = &life.state.scarecrows[0];
        assert_eq!(cell_centre(sc, 0), (-211.0, -243.0));
        assert_eq!(cell_centre(sc, 6), (-207.0, -241.0));
        assert_eq!(cell_at(&life, -205.5, -237.1), Some((0, 15)));
        assert_eq!(cell_at(&life, -211.99, -243.99), Some((0, 0)));
        assert_eq!(cell_at(&life, -212.01, -240.0), None);
        // Turned plots turn their cells with them.
        life.state.scarecrows[0].rot = 0.7;
        let (x, z) = cell_centre(&life.state.scarecrows[0], 9);
        assert_eq!(cell_at(&life, x, z), Some((0, 9)));
    }

    #[test]
    fn barley_from_seed_to_harvest() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        let sc = add_scarecrow(&mut life, &mut sim, -208.0, -240.0, 0.0);
        life.give("seed.barley", 3, true);
        assert!(plant(&mut life, sc, 0, "seed.barley"));
        assert!(!plant(&mut life, sc, 0, "seed.barley"), "the cell is taken");
        assert!(water(&mut life, sc, 0));
        assert!(!water(&mut life, sc, 0), "watered already");
        assert_eq!(life.state.labor, 799.0);
        let dt = 1.0 / 60.0;
        for _ in 0..600 {
            life.state.clock += dt;
            step_farms(&mut life, dt);
        }
        let barley = plant_at(&life, sc, 0).unwrap();
        assert_eq!((barley.growth, barley.watered), (0.0625000000000006, true));
        life.state.clock += 200.0;
        grow_for(&mut life, 200.0);
        let barley = plant_at(&life, sc, 0).unwrap();
        assert_eq!((barley.growth, barley.watered), (1.0, false));
        life.drain_events();
        assert!(harvest(&mut life, sc, 0, 5.0));
        // The island's own random stream: the browser draws the same six.
        assert_eq!(life.state.bag, stacks(&[("seed.barley", 2), ("barley", 6)]));
        assert_eq!(life.drain_events(), vec![got(6, "barley"), LifeEvent::Harvest { x: -211.0, y: 5.0, z: -243.0 }]);
        assert!(plant_at(&life, sc, 0).is_none());
        assert_eq!((life.state.stats.harvested, life.state.labor), (1.0, 797.0));
    }

    #[test]
    fn apple_trees_fruit_again_and_grown_trees_fell_for_timber() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        let sc = add_scarecrow(&mut life, &mut sim, -208.0, -240.0, 0.0);
        life.give("sapling.apple", 1, true);
        life.give("sapling.pine", 1, true);
        assert!(plant(&mut life, sc, 5, "sapling.apple") && plant(&mut life, sc, 6, "sapling.pine"));
        life.state.clock += 700.0;
        grow_for(&mut life, 700.0);
        life.drain_events();
        assert!(harvest(&mut life, sc, 5, 2.0));
        let apple = plant_at(&life, sc, 5).unwrap();
        assert!(apple.picked && apple.growth == 2.0 / 3.0 && stage_of(apple) == 2);
        assert!(!harvest(&mut life, sc, 6, 2.0), "pines bear nothing");
        assert!(fell(&mut life, sc, 5, 2.0) && fell(&mut life, sc, 6, 2.0));
        assert_eq!(life.state.bag, stacks(&[("apple", 6), ("lumber", 12)]));
        let timber = |x: f64| LifeEvent::Gather { x, y: 2.0, z: -241.0, kind: "timber".into() };
        assert_eq!(
            life.drain_events(),
            vec![got(6, "apple"), LifeEvent::Harvest { x: -209.0, y: 2.0, z: -241.0 }, got(5, "lumber"), timber(-209.0), got(7, "lumber"), timber(-207.0)]
        );
        assert_eq!(life.state.rng, 567901804);
        assert!(plant_at(&life, sc, 5).is_none() && plant_at(&life, sc, 6).is_none());
    }

    #[test]
    fn a_felled_tree_gives_the_rare_find_its_crop_names_with_its_toast_and_its_effect() {
        let tree =
            crate::life::content::crops().iter().find(|c| c.chop.as_ref().is_some_and(|ch| ch.rare.is_some())).expect("a tree with something rare in it");
        let chop = tree.chop.as_ref().unwrap();
        let rare = chop.rare.as_ref().unwrap();
        let (mut life, _, _) = island();
        let cells = vec![Some(Plant { picked: true, ..crop(&tree.id, 1.0) })];
        life.state.scarecrows.push(Scarecrow { id: 7, x: -150.0, z: -210.0, rot: 0.0, cells });
        life.state.labor = crate::life::content::labor().max;
        // The yield is drawn first, then the rare find.
        lucky(&mut life, 1, rare.chance);
        assert!(fell(&mut life, 7, 0, 2.0));
        assert_eq!(life.count(&rare.item), 1);
        let events = life.drain_events();
        assert!(events.iter().any(|e| matches!(e, LifeEvent::Toast { text, .. } if *text == rare.toast)));
        assert_eq!(events.iter().any(|e| matches!(e, LifeEvent::Thunder { .. })), rare.effect.as_deref() == Some("thunder"));
        // What it counts as for a quest is its own too.
        assert!(events.iter().any(|e| matches!(e, LifeEvent::Gather { kind, .. } if *kind == chop.kind)));
    }

    #[test]
    fn a_tree_you_fell_counts_its_timber_toward_a_quest() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        let sc = add_scarecrow(&mut life, &mut sim, -208.0, -240.0, 0.0);
        life.give("sapling.apple", 1, true);
        assert!(plant(&mut life, sc, 5, "sapling.apple"));
        life.state.clock += 700.0;
        grow_for(&mut life, 700.0);
        // Hob's lesson wants ten lumber; an apple tree gives four to six.
        life.state.quests.active = vec![QuestProgress { id: "woodcutting".into(), step: 1, counts: vec![0.0] }];
        assert!(fell(&mut life, sc, 5, 2.0));
        let n = life.count("lumber");
        assert!((4..=6).contains(&n), "{n}");
        assert_eq!(life.state.quests.active[0].counts, [n as f64]);
    }

    #[test]
    fn cells_and_plots_that_are_not_there_are_left_alone() {
        let (mut life, mut world, mut p) = island();
        let mut sim = Sim { player: &mut p, world: &mut world, owner: 1 };
        let sc = add_scarecrow(&mut life, &mut sim, -208.0, -240.0, 0.0);
        life.give("seed.sunroot", 2, true);
        assert!(!plant(&mut life, sc, 16, "seed.sunroot"));
        assert!(!plant(&mut life, 99, 0, "seed.sunroot"));
        assert!(!plant(&mut life, sc, 0, "sunroot"), "produce is not a seed");
        assert!(!plant(&mut life, sc, 0, "no-such-item"));
        assert!(!water(&mut life, sc, 0) && !harvest(&mut life, sc, 0, 0.0) && !fell(&mut life, sc, 0, 0.0));
        assert!(!water(&mut life, sc, usize::MAX) && !harvest(&mut life, 99, 3, 0.0) && !fell(&mut life, sc, 40, 0.0));
        assert_eq!(life.count("seed.sunroot"), 2);
        // A crop the content doesn't know (from some old save) grows nowhere and gives nothing.
        life.state.scarecrows[0].cells[2] = Some(crop("mystery", 1.0));
        step_farms(&mut life, 1.0);
        grow_for(&mut life, 100.0);
        assert!(!harvest(&mut life, sc, 2, 0.0) && !fell(&mut life, sc, 2, 0.0));
        assert!(life.drain_events().is_empty());
    }
}
