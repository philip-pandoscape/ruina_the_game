//! Skills, the tree they live in, and the modifiers they apply.
//!
//! This mirrors src/skills.ts, and the two must agree exactly: the browser predicts with these
//! numbers and this decides with them. That is why the fold below is in a fixed order rather than
//! a convenient one, and why every sum is gathered before it is used.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::tuning::{tuning, AttackStep, SkillMod, NO_ABILITY};

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

fn node_index(id: &str) -> Option<usize> {
    tuning().skills.nodes.iter().position(|n| n.id == id)
}

/// A node needs every skill it lists. Requirements are a graph, not a column.
pub fn requirements_met(s: &SkillSet, index: usize) -> bool {
    let Some(n) = tuning().skills.nodes.get(index) else { return false };
    n.requires.iter().all(|id| node_index(id).is_some_and(|i| has_skill(s, i)))
}

/// A set is sound when every learned node's requirements are also learned.
pub fn sound_tree(s: &SkillSet) -> bool {
    (0..tuning().skills.nodes.len()).all(|i| !has_skill(s, i) || requirements_met(s, i))
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
    if let Some(skill) = &m.skill {
        if c.skill != Some(skill.as_str()) {
            return false;
        }
    }
    m.tags.iter().all(|t| c.tags.contains(t))
}

pub fn gather(s: &SkillSet, ctx: &ModContext) -> Vec<Channel> {
    let t = tuning();
    let mut out = vec![Channel::default(); t.stats.len()];
    // Node order, so the product below is the same sequence on both sides.
    for (i, node) in t.skills.nodes.iter().enumerate() {
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
    out
}

// ---------- Resolved per build ----------

/// Gathering walks the whole tree, so it happens once when a build changes and never in a frame.
#[derive(Clone, Debug)]
pub struct ResolvedSkills {
    pub weapon: Vec<Vec<Channel>>,  // [weapon][stat]
    pub ability: Vec<Vec<Channel>>, // [ability][stat]
    pub combos: HashSet<String>,
    pub weapons: Vec<u8>,
    pub abilities: Vec<u8>,
    pub combo_variant_bits: u8,
    /// Each weapon's combo with this build's variants and numbers already applied, so a frame
    /// of the sim is an index rather than a rebuild.
    pub combo: Vec<Vec<AttackStep>>,
}

impl Default for ResolvedSkills {
    fn default() -> Self {
        resolve_skills(&EMPTY_SKILLS)
    }
}

/// Every combo variant in the data, in order, so each gets a stable bit for the wire.
pub fn variant_ids() -> &'static Vec<String> {
    static IDS: OnceLock<Vec<String>> = OnceLock::new();
    IDS.get_or_init(|| tuning().weapons.iter().flat_map(|w| w.variants.iter().map(|v| v.id.clone())).collect())
}

pub fn resolve_skills(s: &SkillSet) -> ResolvedSkills {
    let t = tuning();
    let mut combos = HashSet::new();
    let mut weapons = Vec::new();
    let mut abilities = Vec::new();
    for (i, node) in t.skills.nodes.iter().enumerate() {
        if !has_skill(s, i) {
            continue;
        }
        let Some(g) = &node.grants else { continue };
        if let Some(c) = &g.combo {
            combos.insert(c.clone());
        }
        if let Some(w) = g.weapon {
            weapons.push(w);
        }
        if let Some(a) = g.ability {
            abilities.push(a);
        }
    }
    let weapon: Vec<Vec<Channel>> = t
        .weapons
        .iter()
        .enumerate()
        .map(|(w, def)| gather(s, &ModContext { tags: &def.tags, weapon: Some(w as u8), skill: None }))
        .collect();
    let ability: Vec<Vec<Channel>> = t
        .abilities
        .iter()
        .map(|a| gather(s, &ModContext { tags: &a.tags, weapon: None, skill: Some(&a.id) }))
        .collect();
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
    ResolvedSkills { weapon, ability, combos, weapons, abilities, combo_variant_bits: bits, combo }
}

/// Checks a build the browser asked for: a sound tree within the points allowed, a weapon it has
/// trained, and a hotbar holding only abilities it has learned, each in at most one slot.
pub fn valid_build(skills: &SkillSet, weapon: u8, abilities: &[u8]) -> bool {
    let t = tuning();
    // Nothing learned beyond the end of the tree.
    for i in t.skills.nodes.len()..MAX_NODES {
        if has_skill(skills, i) {
            return false;
        }
    }
    if skill_count(skills) > t.skills.points || !sound_tree(skills) {
        return false;
    }
    let r = resolve_skills(skills);
    if !r.weapons.contains(&weapon) {
        return false;
    }
    for (i, &a) in abilities.iter().enumerate() {
        if a == NO_ABILITY {
            continue;
        }
        if !r.abilities.contains(&a) || abilities[..i].contains(&a) {
            return false;
        }
    }
    true
}
