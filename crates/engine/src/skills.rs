//! Skills, the tree they live in, the levels the ones you use gain, and the modifiers all of that
//! applies.
//!
//! This mirrors src/content/skills.ts, and the two must agree exactly: the browser predicts with these
//! numbers and this decides with them. That is why the fold below is in a fixed order rather than
//! a convenient one, and why every sum is gathered before it is used.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use crate::tuning::{AttackStep, NO_ABILITY, NO_MOVEMENT, SkillMod, SkillNode, skill_tree, tuning};

/// A learned set travels as this many 32-bit words, so the wire size never depends on the tree.
/// Must match maxNodes in shared/tuning.json (checked when the tuning is loaded).
pub const SKILL_WORDS: usize = 8;
pub const MAX_NODES: usize = SKILL_WORDS * 32;

pub type SkillSet = [u32; SKILL_WORDS];

pub const EMPTY_SKILLS: SkillSet = [0; SKILL_WORDS];

pub fn has_skill(s: &SkillSet, index: usize) -> bool {
    index < MAX_NODES && s[index >> 5] & (1 << (index & 31)) != 0
}

pub fn set_skill(s: &mut SkillSet, index: usize, on: bool) {
    if index >= MAX_NODES {
        return;
    }
    let bit = 1 << (index & 31);
    if on {
        s[index >> 5] |= bit;
    } else {
        s[index >> 5] &= !bit;
    }
}

pub fn skill_count(s: &SkillSet) -> u32 {
    s.iter().map(|w| w.count_ones()).sum()
}

// ---------- The tree ----------

/// Every node, in the order a learned set's bits mean (shared/skilltree.json).
pub fn nodes() -> &'static [SkillNode] {
    &skill_tree().nodes
}

pub fn node_index(id: &str) -> Option<usize> {
    nodes().iter().position(|n| n.id == id)
}

/// A set from node ids, for tests and tools (skillsFrom in src/content/skills.ts). An unknown id is a
/// mistake in the caller, not something to carry on past.
pub fn skills_from(ids: &[&str]) -> SkillSet {
    let mut out = EMPTY_SKILLS;
    for id in ids {
        set_skill(&mut out, node_index(id).unwrap_or_else(|| panic!("unknown skill: {id}")), true);
    }
    out
}

/// Each node's neighbours, in ascending order (both languages walk them the same way).
pub fn adjacent() -> &'static [Vec<usize>] {
    static ADJACENT: OnceLock<Vec<Vec<usize>>> = OnceLock::new();
    ADJACENT.get_or_init(|| {
        let end = |v: Option<&serde_json::Value>| -> usize {
            let id = v.and_then(|v| v.as_str()).unwrap_or_else(|| panic!("shared/skilltree.json: a link needs two node ids, not {v:?}"));
            node_index(id).unwrap_or_else(|| panic!("unknown skill: {id}"))
        };
        let links: Vec<(usize, usize)> = skill_tree().links.iter().map(|l| (end(l.first()), end(l.get(1)))).collect();
        (0..nodes().len())
            .map(|i| {
                let mut out = Vec::new();
                for &(a, b) in &links {
                    if a == i {
                        out.push(b);
                    }
                    if b == i {
                        out.push(a);
                    }
                }
                out.sort_unstable();
                out
            })
            .collect()
    })
}

/// The nodes you can start from, in node order.
pub fn roots() -> &'static [usize] {
    static ROOTS: OnceLock<Vec<usize>> = OnceLock::new();
    ROOTS.get_or_init(|| nodes().iter().enumerate().filter(|(_, n)| n.root).map(|(i, _)| i).collect())
}

// ---------- Where you can go ----------
//
// You learn outward from where the tree starts: a node is open to you when it is a root or touches
// one you've learned, and what you've learned must always hang together back to a root.

/// The learned nodes a root reaches through learned nodes, leaving out `without`.
fn reached(s: &SkillSet, without: Option<usize>) -> Vec<bool> {
    let adjacent = adjacent();
    let mut seen = vec![false; nodes().len()];
    let mut queue: Vec<usize> = Vec::new();
    for &r in roots() {
        if Some(r) != without && has_skill(s, r) {
            seen[r] = true;
            queue.push(r);
        }
    }
    let mut q = 0;
    while q < queue.len() {
        for &n in &adjacent[queue[q]] {
            if seen[n] || Some(n) == without || !has_skill(s, n) {
                continue;
            }
            seen[n] = true;
            queue.push(n);
        }
        q += 1;
    }
    seen
}

/// Whether a node is open to learn: a root, or next to something learned.
pub fn reachable(s: &SkillSet, index: usize) -> bool {
    let Some(n) = nodes().get(index) else { return false };
    n.root || adjacent()[index].iter().any(|&j| has_skill(s, j))
}

/// Everything that would be cut off if `index` were unlearned, including itself, in node order.
pub fn dependents(s: &SkillSet, index: usize) -> Vec<usize> {
    if !has_skill(s, index) {
        return Vec::new();
    }
    let still = reached(s, Some(index));
    (0..nodes().len()).filter(|&i| has_skill(s, i) && (i == index || !still[i])).collect()
}

/// A set is sound when nothing is learned beyond the end of the tree and everything learned hangs
/// together back to a root.
pub fn sound_tree(s: &SkillSet) -> bool {
    if (nodes().len()..MAX_NODES).any(|i| has_skill(s, i)) {
        return false;
    }
    let seen = reached(s, None);
    (0..nodes().len()).all(|i| !has_skill(s, i) || seen[i])
}

/// The cheapest way to `index` from what you've learned: the nodes to learn, nearest first,
/// ending with it. Empty if it is already learned. Ties go to the lower index, the same on every
/// machine (pathTo in src/content/skills.ts).
pub fn path_to(s: &SkillSet, index: usize) -> Vec<usize> {
    let count = nodes().len();
    if index >= count || has_skill(s, index) {
        return Vec::new();
    }
    const UNSEEN: usize = usize::MAX;
    const START: usize = usize::MAX - 1;
    let adjacent = adjacent();
    let mut prev = vec![UNSEEN; count];
    let mut queue: Vec<usize> = Vec::new();
    // Start from every open node: one step away from what you have.
    for (i, p) in prev.iter_mut().enumerate() {
        if !has_skill(s, i) && reachable(s, i) {
            *p = START;
            queue.push(i);
        }
    }
    let mut q = 0;
    while q < queue.len() {
        let at = queue[q];
        q += 1;
        if at == index {
            break;
        }
        for &n in &adjacent[at] {
            if prev[n] != UNSEEN || has_skill(s, n) {
                continue;
            }
            prev[n] = at;
            queue.push(n);
        }
    }
    if prev[index] == UNSEEN {
        return Vec::new();
    }
    let mut out = vec![index];
    let mut at = index;
    while prev[at] != START {
        at = prev[at];
        out.push(at);
    }
    out.reverse();
    out
}

// ---------- Modifiers ----------

/// The three accumulated stages for one stat, ready to apply to any base.
#[derive(Clone, Copy, Debug)]
pub struct Channel {
    pub flat: f64,
    pub inc: f64,
    pub more: f64, // already multiplied out
}

impl Default for Channel {
    fn default() -> Self {
        Channel { flat: 0.0, inc: 0.0, more: 1.0 }
    }
}

impl Channel {
    /// (base + Σflat) × (1 + Σinc) × Π(1 + more), and in that order.
    pub fn apply(&self, base: f64) -> f64 {
        (base + self.flat) * (1.0 + self.inc) * self.more
    }

    /// Frame counts are whole numbers; the browser rounds the same way.
    pub fn frames(&self, base: i32) -> i32 {
        self.apply(base as f64).round().max(0.0) as i32
    }
}

pub fn stat_index(id: &str) -> usize {
    tuning().stats.iter().position(|s| s.id == id).unwrap_or_else(|| panic!("unknown stat: {id}"))
}

pub fn stat_base(index: usize) -> f64 {
    tuning().stats.get(index).map_or(0.0, |s| s.base)
}

/// What a skill or a swing is, for deciding which modifiers apply.
pub struct ModContext<'a> {
    pub tags: &'a [String],
    pub weapon: Option<u8>,
    pub skill: Option<&'a str>,
}

fn applies(m: &SkillMod, c: &ModContext) -> bool {
    if m.weapon.is_some() && m.weapon != c.weapon {
        return false;
    }
    if let Some(skill) = &m.skill
        && c.skill != Some(skill.as_str())
    {
        return false;
    }
    m.tags.iter().all(|t| c.tags.contains(t))
}

/// Every modifier that reaches `ctx`: the learned nodes', then what the skill book's levels add.
/// `levels` has one entry per book() entry; a missing one is level 1.
pub fn gather(s: &SkillSet, ctx: &ModContext, levels: &[u32]) -> Vec<Channel> {
    let t = tuning();
    let mut out = vec![Channel::default(); t.stats.len()];
    // Node order, so the product below is the same sequence on both sides.
    for (i, node) in nodes().iter().enumerate() {
        if !has_skill(s, i) {
            continue;
        }
        for m in &node.mods {
            if !applies(m, ctx) {
                continue;
            }
            let c = &mut out[stat_index(&m.stat)];
            match m.op.as_str() {
                "flat" => c.flat += m.value,
                "inc" => c.inc += m.value,
                _ => c.more *= 1.0 + m.value,
            }
        }
    }
    // Then what each skill's levels add, once per level past the first. Sums only, so the order
    // they come in doesn't matter.
    for (b, mods) in level_mods().iter().enumerate() {
        let extra = i64::from(levels.get(b).copied().unwrap_or(1)) - 1;
        if extra <= 0 {
            continue;
        }
        for m in mods.iter() {
            if !applies(m, ctx) {
                continue;
            }
            let c = &mut out[stat_index(&m.stat)];
            if m.op == "flat" {
                c.flat += m.value * extra as f64;
            } else {
                c.inc += m.value * extra as f64;
            }
        }
    }
    out
}

// ---------- The skill book: what levels up ----------
//
// Every weapon, ability and movement skill gains experience as you use it (a weapon for each hit
// it lands, an ability for each cast, a movement skill each time you use it) and a level at each
// step of the curve. What a level adds is data too: tuning.json skills.levels. The experience is
// kept with your island (crate::life::progress).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BookKind {
    Weapon,
    Ability,
    Movement,
}

#[derive(Clone, Debug)]
pub struct BookSkill {
    /// The tree node that grants the weapon, or the ability's or movement skill's own id.
    pub id: String,
    pub kind: BookKind,
    /// Its weapon, ability or movement skill index.
    pub index: u8,
}

/// Weapons in weapon order, then abilities, then movement skills: the order levels are kept in.
pub fn book() -> &'static [BookSkill] {
    static BOOK: OnceLock<Vec<BookSkill>> = OnceLock::new();
    BOOK.get_or_init(|| {
        let t = tuning();
        let mut out = Vec::new();
        for w in 0..t.weapons.len() {
            let id =
                nodes().iter().find(|n| n.grants.as_ref().is_some_and(|g| g.weapon == Some(w as u8))).map_or_else(|| format!("weapon{w}"), |n| n.id.clone());
            out.push(BookSkill { id, kind: BookKind::Weapon, index: w as u8 });
        }
        for (i, a) in t.abilities.iter().enumerate() {
            out.push(BookSkill { id: a.id.clone(), kind: BookKind::Ability, index: i as u8 });
        }
        for (i, m) in t.movement_skills.iter().enumerate() {
            out.push(BookSkill { id: m.id.clone(), kind: BookKind::Movement, index: i as u8 });
        }
        out
    })
}

pub fn book_index(id: &str) -> Option<usize> {
    book().iter().position(|b| b.id == id)
}

/// The book entry for a weapon, an ability or a movement skill.
pub fn book_of(kind: BookKind, index: u8) -> Option<usize> {
    book().iter().position(|b| b.kind == kind && b.index == index)
}

/// What every level past the first adds, per book entry. Checked as the browser checks it: every
/// id is in the book, and nothing multiplies.
fn level_mods() -> &'static [&'static [SkillMod]] {
    static MODS: OnceLock<Vec<&'static [SkillMod]>> = OnceLock::new();
    MODS.get_or_init(|| {
        let per = &tuning().skills.levels.per;
        for (id, mods) in per {
            assert!(book_index(id).is_some(), "skills.levels.per names \"{id}\", which isn't in the skill book");
            assert!(mods.iter().all(|m| m.op != "more"), "skills.levels.per.{id}: levels add flat or inc, never more");
        }
        book().iter().map(|b| per.get(&b.id).map_or(&[][..], |v| v.as_slice())).collect()
    })
}

/// A level per book() entry, 1..=max_level().
pub type Levels = Vec<u32>;

/// Everything at level 1.
pub fn base_levels() -> Levels {
    vec![1; book().len()]
}

pub fn max_level() -> u32 {
    tuning().skills.levels.xp.len() as u32
}

/// The level this much experience has reached.
pub fn level_of(xp: f64) -> u32 {
    let curve = &tuning().skills.levels.xp;
    let mut level = 1;
    while (level as usize) < curve.len() && xp >= curve[level as usize] {
        level += 1;
    }
    level
}

/// Levels from experience kept by skill book id (the island's skill_xp).
pub fn levels_from(xp: &BTreeMap<String, f64>) -> Levels {
    book().iter().map(|b| level_of(xp.get(b.id.as_str()).copied().unwrap_or(0.0))).collect()
}

/// Whether two sets of levels are the same, a missing entry counting as level 1.
pub fn same_levels(a: &[u32], b: &[u32]) -> bool {
    (0..book().len()).all(|i| a.get(i).copied().unwrap_or(1) == b.get(i).copied().unwrap_or(1))
}

// ---------- Resolved per build ----------

/// Gathering walks the whole tree, so it happens once when a build or a level changes and never
/// in a frame. The result is a set of channels per weapon, for swings; per ability, for casts; and
/// per movement skill, for its cooldown.
#[derive(Clone, Debug)]
pub struct ResolvedSkills {
    pub weapon: Vec<Vec<Channel>>,  // [weapon][stat]
    pub ability: Vec<Vec<Channel>>, // [ability][stat]
    /// [movement skill][stat] (`move` in the TypeScript).
    pub moves: Vec<Vec<Channel>>,
    pub combos: BTreeSet<String>,
    pub weapons: Vec<u8>,
    pub abilities: Vec<u8>,
    /// Movement skills it has learned.
    pub movement: Vec<u8>,
    pub combo_variant_bits: u8,
    /// Each weapon's combo with this build's variants and numbers already applied, so a frame
    /// of the sim is an index rather than a rebuild.
    pub combo: Vec<Vec<AttackStep>>,
}

impl Default for ResolvedSkills {
    fn default() -> Self {
        resolve_skills(&EMPTY_SKILLS, &[])
    }
}

/// Every combo variant in the data, in order, so each gets a stable bit for the wire.
pub fn variant_ids() -> &'static Vec<String> {
    static IDS: OnceLock<Vec<String>> = OnceLock::new();
    IDS.get_or_init(|| tuning().weapons.iter().flat_map(|w| w.variants.iter().map(|v| v.id.clone())).collect())
}

/// What a learned set grants, in node order.
struct Grants {
    combos: BTreeSet<String>,
    weapons: Vec<u8>,
    abilities: Vec<u8>,
    movement: Vec<u8>,
}

fn granted(s: &SkillSet) -> Grants {
    let mut out = Grants { combos: BTreeSet::new(), weapons: Vec::new(), abilities: Vec::new(), movement: Vec::new() };
    for (i, node) in nodes().iter().enumerate() {
        if !has_skill(s, i) {
            continue;
        }
        let Some(g) = &node.grants else { continue };
        if let Some(c) = &g.combo {
            out.combos.insert(c.clone());
        }
        if let Some(w) = g.weapon {
            out.weapons.push(w);
        }
        if let Some(a) = g.ability {
            out.abilities.push(a);
        }
        if let Some(m) = g.movement {
            out.movement.push(m);
        }
    }
    out
}

/// What a learned set does at these levels (one per book() entry; a missing one is level 1).
pub fn resolve_skills(s: &SkillSet, levels: &[u32]) -> ResolvedSkills {
    let t = tuning();
    let Grants { combos, weapons, abilities, movement } = granted(s);
    let weapon: Vec<Vec<Channel>> =
        t.weapons.iter().enumerate().map(|(w, def)| gather(s, &ModContext { tags: &def.tags, weapon: Some(w as u8), skill: None }, levels)).collect();
    let ability: Vec<Vec<Channel>> = t.abilities.iter().map(|a| gather(s, &ModContext { tags: &a.tags, weapon: None, skill: Some(&a.id) }, levels)).collect();
    let moves: Vec<Vec<Channel>> =
        t.movement_skills.iter().map(|m| gather(s, &ModContext { tags: &m.tags, weapon: None, skill: Some(&m.id) }, levels)).collect();
    let mut bits = 0u8;
    for (i, id) in variant_ids().iter().enumerate() {
        if combos.contains(id) {
            bits |= 1 << i;
        }
    }
    let startup = stat_index("attack.startup");
    let attack_damage = stat_index("attack.damage");
    let combo = t
        .weapons
        .iter()
        .enumerate()
        .map(|(w, def)| {
            let mut steps = def.combo.clone();
            for v in &def.variants {
                if combos.contains(&v.id) && v.replace < steps.len() {
                    steps[v.replace] = v.step.clone();
                }
            }
            let ch = &weapon[w];
            for step in steps.iter_mut() {
                step.startup = ch[startup].frames(step.startup);
                step.damage = ch[attack_damage].apply(step.damage);
            }
            steps
        })
        .collect();
    ResolvedSkills { weapon, ability, moves, combos, weapons, abilities, movement, combo_variant_bits: bits, combo }
}

/// Checks a build the browser asked for: a sound tree within the points it may spend (`budget`:
/// skills.points on the battlefield, what the character has earned in the open world), a weapon it
/// has trained, and a hotbar holding only abilities it has learned, each in at most one slot.
pub fn valid_build(skills: &SkillSet, weapon: u8, abilities: &[u8], budget: u32) -> bool {
    if !sound_tree(skills) || skill_count(skills) > budget {
        return false;
    }
    let g = granted(skills);
    if !g.weapons.contains(&weapon) {
        return false;
    }
    for (i, &a) in abilities.iter().enumerate() {
        if a == NO_ABILITY {
            continue;
        }
        if !g.abilities.contains(&a) || abilities[..i].contains(&a) {
            return false;
        }
    }
    true
}

/// The rest of a build's check (validBuild in src/app/build.ts): the Q / E slots hold only movement
/// skills the set has learned, each in at most one slot. Movement skills cost points like anything
/// else in the tree, so one can't be slotted without them.
pub fn valid_movement(skills: &SkillSet, movement: &[u8]) -> bool {
    let g = granted(skills);
    movement.iter().enumerate().all(|(i, &m)| m == NO_MOVEMENT || (g.movement.contains(&m) && !movement[..i].contains(&m)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tuning::{HOTBAR_SLOTS, movement_cooldown_for, movement_stamina_for};

    fn at(id: &str) -> usize {
        node_index(id).unwrap_or_else(|| panic!("no node {id}"))
    }

    fn ids(list: &[usize]) -> Vec<String> {
        list.iter().map(|&i| nodes()[i].id.clone()).collect()
    }

    fn bar() -> [u8; HOTBAR_SLOTS] {
        [NO_ABILITY; HOTBAR_SLOTS]
    }

    /// A sound set of `n` nodes grown outward from Sword Training.
    fn grown(n: usize) -> SkillSet {
        let mut s = EMPTY_SKILLS;
        let mut queue = vec![at("sword")];
        set_skill(&mut s, queue[0], true);
        let mut q = 0;
        while q < queue.len() && (skill_count(&s) as usize) < n {
            for &j in &adjacent()[queue[q]] {
                if !has_skill(&s, j) && (skill_count(&s) as usize) < n {
                    set_skill(&mut s, j, true);
                    queue.push(j);
                }
            }
            q += 1;
        }
        assert_eq!(skill_count(&s) as usize, n);
        s
    }

    #[test]
    fn the_tree_holds_together() {
        let n = nodes();
        assert!(n.len() <= MAX_NODES);
        // The first fifteen are the old skills in their old order, so builds saved before the tree
        // grew still mean the same skills.
        let old = [
            "sword",
            "cleave",
            "whirlwind",
            "club",
            "heal",
            "swiftMending",
            "staff",
            "meteor",
            "quickIncantation",
            "bow",
            "rapidFire",
            "piercing",
            "dodgeRoll",
            "backstep",
            "block",
        ];
        assert_eq!(ids(&(0..15).collect::<Vec<_>>()), old);
        assert_eq!(ids(roots()), ["sword", "club", "staff", "bow"]);
        // Neighbours are listed both ways round and in ascending order.
        for (i, list) in adjacent().iter().enumerate() {
            assert!(list.windows(2).all(|w| w[0] <= w[1]), "{}", n[i].id);
            for &j in list {
                assert!(adjacent()[j].contains(&i), "{} - {}", n[i].id, n[j].id);
            }
        }
        assert_eq!(ids(&adjacent()[at("sword")]), ["cleave", "dodgeRoll", "sw-0-5", "sw-0-7"]);
        // Every node can be reached from nothing.
        assert!((0..n.len()).all(|i| !path_to(&EMPTY_SKILLS, i).is_empty()));
        // The level data names only skills in the book, and never multiplies.
        assert_eq!(level_mods().len(), book().len());
    }

    #[test]
    fn what_each_old_skill_costs_from_nothing() {
        let cost = |id: &str| path_to(&EMPTY_SKILLS, at(id)).len();
        for id in ["sword", "club", "staff", "bow"] {
            assert_eq!(cost(id), 1, "{id}");
        }
        for id in ["cleave", "heal", "meteor", "rapidFire", "dodgeRoll", "backstep", "block"] {
            assert_eq!(cost(id), 2, "{id}");
        }
        for id in ["whirlwind", "swiftMending", "quickIncantation", "piercing"] {
            assert_eq!(cost(id), 3, "{id}");
        }
        // The path itself, nearest first; ties go to the lower index.
        assert_eq!(ids(&path_to(&EMPTY_SKILLS, at("whirlwind"))), ["sword", "cleave", "whirlwind"]);
        assert_eq!(ids(&path_to(&EMPTY_SKILLS, at("block"))), ["club", "block"]);
        // From what you have, not from the start; nothing for what you already have.
        let s = skills_from(&["sword", "cleave"]);
        assert_eq!(ids(&path_to(&s, at("whirlwind"))), ["whirlwind"]);
        assert!(path_to(&s, at("cleave")).is_empty());
        assert!(path_to(&s, nodes().len()).is_empty());
    }

    #[test]
    fn learning_goes_outward_from_a_root() {
        assert!(reachable(&EMPTY_SKILLS, at("bow")), "a root is always open");
        assert!(!reachable(&EMPTY_SKILLS, at("rapidFire")));
        let s = skills_from(&["bow"]);
        assert!(reachable(&s, at("rapidFire")) && reachable(&s, at("backstep")));
        assert!(!reachable(&s, at("piercing")));
        assert!(!reachable(&s, nodes().len()));
        // Sound: everything hangs together back to a root.
        assert!(sound_tree(&EMPTY_SKILLS));
        assert!(sound_tree(&skills_from(&["sword", "cleave", "whirlwind", "dodgeRoll"])));
        assert!(sound_tree(&skills_from(&["bow", "rapidFire", "staff", "meteor"])), "two roots");
        assert!(sound_tree(&grown(nodes().len())), "the whole tree");
        assert!(!sound_tree(&skills_from(&["cleave"])), "not joined to a root");
        assert!(!sound_tree(&skills_from(&["sword", "whirlwind"])), "a gap");
        assert!(!sound_tree(&skills_from(&["heal", "swiftMending", "block"])), "joined up, but to no root");
        // Nothing beyond the end of the tree.
        let mut past = skills_from(&["sword"]);
        set_skill(&mut past, nodes().len(), true);
        assert!(!sound_tree(&past));
    }

    #[test]
    fn unlearning_drops_whatever_it_cut_off() {
        let s = skills_from(&["sword", "cleave", "whirlwind", "dodgeRoll"]);
        assert_eq!(ids(&dependents(&s, at("cleave"))), ["cleave", "whirlwind"]);
        assert_eq!(ids(&dependents(&s, at("whirlwind"))), ["whirlwind"]);
        assert_eq!(ids(&dependents(&s, at("sword"))), ["sword", "cleave", "whirlwind", "dodgeRoll"]);
        assert!(dependents(&s, at("club")).is_empty(), "not learned");
        // A graph, not a column: Block and Healing Circle each still reach Club Training the other way.
        let s = skills_from(&["club", "heal", "swiftMending", "block"]);
        assert_eq!(ids(&dependents(&s, at("block"))), ["block"]);
        assert_eq!(ids(&dependents(&s, at("heal"))), ["heal", "swiftMending"]);
        // Another root keeps its own branch.
        let s = skills_from(&["sword", "staff", "meteor"]);
        assert_eq!(ids(&dependents(&s, at("sword"))), ["sword"]);
    }

    #[test]
    fn a_build_must_fit_its_budget() {
        let one = skills_from(&["sword"]);
        assert!(valid_build(&one, 0, &bar(), 1));
        assert!(!valid_build(&one, 0, &bar(), 0));
        let three = skills_from(&["sword", "cleave", "whirlwind"]);
        assert!(!valid_build(&three, 0, &bar(), 2));
        assert!(valid_build(&three, 0, &bar(), 3));
        // The battlefield's budget: everything up to it, and not one more.
        let points = tuning().skills.points;
        assert!(valid_build(&grown(points as usize), 0, &bar(), points));
        assert!(!valid_build(&grown(points as usize + 1), 0, &bar(), points));
        // Still a weapon it has, abilities it knows, each once, and a sound tree.
        assert!(!valid_build(&one, 1, &bar(), points), "no club");
        let mut hotbar = bar();
        hotbar[0] = 0;
        assert!(!valid_build(&one, 0, &hotbar, points), "Healing Circle not learned");
        let healer = skills_from(&["club", "heal"]);
        assert!(valid_build(&healer, 1, &hotbar, 2));
        hotbar[3] = 0;
        assert!(!valid_build(&healer, 1, &hotbar, points), "in two slots");
        assert!(!valid_build(&skills_from(&["sword", "whirlwind"]), 0, &bar(), points));
    }

    #[test]
    fn movement_slots_hold_only_what_was_learned() {
        let dodger = skills_from(&["sword", "dodgeRoll"]);
        assert!(valid_movement(&dodger, &[NO_MOVEMENT, NO_MOVEMENT]));
        assert!(valid_movement(&dodger, &[NO_MOVEMENT, 0]));
        assert!(!valid_movement(&skills_from(&["sword"]), &[0, NO_MOVEMENT]), "Dodge Roll not learned");
        assert!(!valid_movement(&dodger, &[0, 0]), "in both slots");
        assert!(!valid_movement(&dodger, &[crate::tuning::slide_skill(), NO_MOVEMENT]), "the slide is everyone's, never a slot's");
    }

    #[test]
    fn the_skill_book_and_its_levels() {
        let names: Vec<&str> = book().iter().map(|s| s.id.as_str()).collect();
        assert_eq!(names, ["sword", "club", "staff", "bow", "heal", "meteor", "dodgeRoll", "backstep", "block", "slide"]);
        assert_eq!(book_of(BookKind::Weapon, 3), Some(3));
        assert_eq!(book_of(BookKind::Ability, 1), book_index("meteor"));
        assert_eq!(book_of(BookKind::Movement, 3), book_index("slide"));
        assert_eq!(book_of(BookKind::Weapon, 9), None);
        // The curve: 20 for level 2, then 60, 120, ... up to 10.
        assert_eq!(max_level(), 10);
        let cases = [(0.0, 1), (19.0, 1), (20.0, 2), (59.0, 2), (60.0, 3), (899.0, 9), (900.0, 10), (1e9, 10)];
        for (xp, level) in cases {
            assert_eq!(level_of(xp), level, "{xp}");
        }
        let mut xp = BTreeMap::new();
        xp.insert("bow".to_string(), 120.0);
        xp.insert("slide".to_string(), 25.0);
        xp.insert("nothing".to_string(), 999.0);
        assert_eq!(levels_from(&xp), [1, 1, 1, 4, 1, 1, 1, 1, 1, 2]);
        assert!(same_levels(&base_levels(), &[]));
        assert!(!same_levels(&levels_from(&xp), &base_levels()));
    }

    #[test]
    fn levels_add_to_what_a_skill_does() {
        let damage = stat_index("attack.damage");
        let amount = stat_index("ability.amount");
        let s = skills_from(&["sword", "club", "heal", "dodgeRoll"]);
        let mut levels = base_levels();
        // Level 1 adds nothing.
        let plain = resolve_skills(&s, &[]);
        assert_eq!(resolve_skills(&s, &levels).weapon[0][damage].inc, plain.weapon[0][damage].inc);
        levels[book_index("sword").unwrap()] = 5;
        levels[book_index("heal").unwrap()] = 3;
        levels[book_index("dodgeRoll").unwrap()] = 10;
        let r = resolve_skills(&s, &levels);
        // Sword level 5: four levels of +3% damage, on the sword alone.
        assert_eq!(r.weapon[0][damage].inc, 0.03 * 4.0);
        assert_eq!(r.weapon[1][damage].inc, 0.0);
        let base = tuning().weapons[0].combo[0].damage;
        assert_eq!(r.combo[0][0].damage, base * (1.0 + 0.03 * 4.0));
        assert_eq!(r.ability[0][amount].inc, 0.05 * 2.0);
        // Dodge Roll level 10: its stamina, 27% less. It has no cooldown to shorten.
        let cost = tuning().movement_skills[0].stamina_cost;
        assert_eq!(movement_stamina_for(0, &r), cost * (1.0 - 0.03 * 9.0));
        assert_eq!(movement_stamina_for(0, &plain), cost);
        assert_eq!((movement_cooldown_for(0, &r), movement_cooldown_for(0, &plain)), (0, 0));
        // The tree's own modifiers come first, then the levels' sums.
        let footwork = skills_from(&["sword", "cleave", "sw-1-10", "dodgeRoll"]);
        let r = resolve_skills(&footwork, &levels);
        assert_eq!(movement_stamina_for(0, &r), cost * (1.0 + -0.03 * 9.0) * (1.0 - 0.05));
        // And learned movement skills are listed like weapons and abilities.
        assert_eq!(r.movement, [0]);
    }
}
