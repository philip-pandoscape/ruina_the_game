//! Gameplay numbers, read from shared/tuning.json (the same file the browser uses), and the skill
//! tree from shared/skilltree.json.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::skills::{Channel, MAX_NODES, ResolvedSkills, stat_base, stat_index};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub sim_hz: f64,
    #[serde(rename = "move")]
    pub movement: Move,
    pub jump: Jump,
    pub attack: Attack,
    pub special: SpecialSettings,
    pub weapons: Vec<Weapon>,
    pub abilities: Vec<Ability>,
    pub skills: Skills,
    pub combat: Combat,
    pub stamina: Stamina,
    pub mp: Mp,
    pub hotbar: Hotbar,
    pub stats: Vec<StatDef>,
    pub movement_skills: Vec<MovementSkill>,
    pub movement_slots: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub walk_speed: f64,
    pub run_speed: f64,
    pub run_threshold: f64,
    pub ground_accel: f64,
    pub ground_decel: f64,
    pub air_accel: f64,
    pub air_drag: f64,
    pub turn_speed: f64,
    pub player_radius: f64,
    pub sprint_speed: f64,
    pub sprint_accel: f64,
    pub crouch_speed: f64,
    pub crouch_height: f64,
    pub crouch_enter_frames: i32,
    /// Share of full speed strafing and backing away in combat stance (Actions::face_x / face_z).
    pub strafe_speed: f64,
    pub back_speed: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotbar {
    pub slots: usize,
}

/// Hotbar size as a compile-time constant, so builds and loadouts are fixed-size arrays and the
/// wire format has a fixed length. Checked against shared/tuning.json when the tuning is loaded.
pub const HOTBAR_SLOTS: usize = 8;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Jump {
    pub velocity: f64,
    pub double_jump_velocity: f64,
    pub gravity_up: f64,
    pub gravity_down: f64,
    pub max_fall: f64,
    pub short_hop_cut: f64,
    pub coyote_frames: i32,
    pub buffer_frames: i32,
    pub double_jump_steer: f64,
    pub flip_frames: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attack {
    pub buffer_frames: i32,
    pub air_gravity_scale: f64,
    /// Offline, a swing turns toward what's nearest within this range and this many degrees.
    pub auto_aim_range: f64,
    pub auto_aim_deg: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialSettings {
    pub buffer_frames: i32,
    pub cancel_cooldown_frames: i32,
    pub interrupt_cooldown_frames: i32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttackStep {
    pub startup: i32,
    pub active: i32,
    pub recovery: i32,
    pub damage: f64,
    pub lunge: f64,
    pub reach: f64,
    pub arc_deg: f64,
    /// Offline, the frames everything freezes when the blow lands, and how hard it rocks what it hits.
    #[serde(default)]
    pub hitstop: i32,
    #[serde(default)]
    pub knock: f64,
    pub player_knock: f64,
    pub cancel_after: i32,
    #[serde(default)]
    pub projectile_speed: f64, // arrows only
    #[serde(default)]
    pub projectile_range: f64,
    /// Names an animation for the browser; the rules never look at it.
    #[serde(default)]
    pub pose: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Combat {
    pub max_hp: f64,
    pub stun_frames: i32,
    pub knock_up: f64,
    pub down_frames: i32,
}

/// Every fighter's stamina: dodges spend it (MovementSkill::stamina_cost), and it refills at
/// regen_per_second once regen_delay_frames have passed since it was last spent.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamina {
    pub max: f64,
    pub regen_per_second: f64,
    pub regen_delay_frames: i32,
}

/// Every fighter's MP: casting spends it (Ability::mp_cost, paid when the cast goes off), and it
/// refills at regen_per_second.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp {
    pub max: f64,
    pub regen_per_second: f64,
}

static TUNING: OnceLock<Tuning> = OnceLock::new();

pub fn tuning() -> &'static Tuning {
    TUNING.get_or_init(|| {
        let mut t: Tuning =
            serde_json::from_str(crate::bundles::bundle("tuning.json", include_str!("../../../shared/tuning.json"))).expect("shared/tuning.json is valid");
        assert_eq!(t.hotbar.slots, HOTBAR_SLOTS, "hotbar.slots in shared/tuning.json must match HOTBAR_SLOTS");
        assert_eq!(t.skills.max_nodes, MAX_NODES, "skills.maxNodes in shared/tuning.json must match SKILL_WORDS");
        assert_eq!(t.movement_slots, MOVEMENT_SLOTS, "movementSlots in shared/tuning.json must match MOVEMENT_SLOTS");
        assert!(
            t.movement_skills.len() <= MOVEMENT_SKILL_CAP,
            "more movement skills than MOVEMENT_SKILL_CAP: raise it here and in src/content/tuning.ts together"
        );
        // What a level adds names the weapon it changes by id; the rules use its place in the list.
        let weapons = &t.weapons;
        for (skill, mods) in &mut t.skills.levels.per {
            for m in mods {
                m.place_weapon(weapons, &format!("shared/tuning.json: skills.levels.per.{skill}"));
            }
        }
        t
    })
}

static SKILL_TREE: OnceLock<SkillTreeFile> = OnceLock::new();

/// The skill tree (shared/skilltree.json, the same file the browser lays its panel out from), with
/// the places of the weapons, abilities and movement skills it names by id.
pub fn skill_tree() -> &'static SkillTreeFile {
    SKILL_TREE.get_or_init(|| {
        let mut tree: SkillTreeFile = serde_json::from_str(crate::bundles::bundle("skilltree.json", include_str!("../../../shared/skilltree.json")))
            .expect("shared/skilltree.json is valid");
        assert!(tree.nodes.len() <= MAX_NODES, "the skill tree has outgrown SKILL_WORDS: raise it here and in src/content/skills.ts together");
        let t = tuning();
        for n in &mut tree.nodes {
            let at = format!("shared/skilltree.json: {}", n.id);
            if let Some(g) = &mut n.grants {
                g.weapon = g.weapon_id.as_deref().map(|id| place(&t.weapons, |w| &w.name, id, &format!("{at} grants the weapon")));
                g.ability = g.ability_id.as_deref().map(|id| place(&t.abilities, |a| &a.id, id, &format!("{at} grants the ability")));
                g.movement = g.movement_id.as_deref().map(|id| place(&t.movement_skills, |m| &m.id, id, &format!("{at} grants the movement skill")));
            }
            for m in &mut n.mods {
                m.place_weapon(&t.weapons, &at);
            }
        }
        tree
    })
}

/// Where the thing with this id is in its list (the order its content/<kind>/_order.json gives),
/// which is how the rules and the wire know it. Content names things by id: one it names that isn't
/// there is a mistake in it, said with `what` (contentc checks the content's own before this).
fn place<T>(list: &[T], id_of: impl Fn(&T) -> &str, id: &str, what: &str) -> u8 {
    let i = list.iter().position(|x| id_of(x) == id).unwrap_or_else(|| panic!("{what} \"{id}\", which shared/tuning.json hasn't got"));
    u8::try_from(i).unwrap_or_else(|_| panic!("{what} \"{id}\", past the 256th in its list"))
}

/// A weapon's place in the list, from its id (its name); None if there's no such weapon.
pub fn weapon_index(id: &str) -> Option<u8> {
    tuning().weapons.iter().position(|w| w.name == id).and_then(|i| u8::try_from(i).ok())
}

/// An ability's place in the list, from its id; None if there's no such ability.
pub fn ability_index(id: &str) -> Option<u8> {
    tuning().abilities.iter().position(|a| a.id == id).and_then(|i| u8::try_from(i).ok())
}

/// A movement skill's place in the list, from its id; None if there's no such movement skill.
pub fn movement_index(id: &str) -> Option<u8> {
    tuning().movement_skills.iter().position(|m| m.id == id).and_then(|i| u8::try_from(i).ok())
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Weapon {
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub combo: Vec<AttackStep>,
    /// Structural alternatives a skill can unlock. Anything that is only a number is a modifier.
    #[serde(default)]
    pub variants: Vec<ComboVariant>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComboVariant {
    pub id: String,
    pub replace: usize,
    pub step: AttackStep,
}

/// Healing Circle or Meteor.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ability {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Where it goes off: "self" or "ground".
    pub target: String,
    pub cast_frames: i32,
    pub cooldown_frames: i32,
    /// MP the cast costs, paid when it goes off.
    #[serde(default)]
    pub mp_cost: f64,
    #[serde(default)]
    pub range: f64,
    #[serde(default)]
    pub max_range: Option<f64>,
    /// What it actually does. The kinds are the vocabulary that costs code (see crate::combat); an
    /// ability built out of them is only data.
    pub effects: Vec<Effect>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub kind: String,
    pub radius: f64,
    #[serde(default)]
    pub amount: f64, // healArea
    #[serde(default)]
    pub damage: f64, // delayedArea
    #[serde(default)]
    pub knock: f64,
    #[serde(default)]
    pub delay_frames: i32, // delayedArea
}

/// tuning.json `skills`. The tree itself is shared/skilltree.json (skill_tree()).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skills {
    /// What the training yard and the battlefield may spend.
    pub points: u32,
    /// What every character starts with in the open world. Each quest and milestone they finish
    /// adds its rewards.skillPoints (crate::life::progress::skill_budget).
    pub start_points: u32,
    pub max_nodes: usize,
    pub trees: Vec<SkillTree>,
    pub levels: SkillLevels,
}

/// The skills in your skill book (crate::skills::book) level up as you use them.
#[derive(Deserialize)]
pub struct SkillLevels {
    /// Total experience each level needs: xp[0] for level 1 (always 0), and so on up. Its length
    /// is the highest level.
    pub xp: Vec<f64>,
    /// What every level past the first adds, by skill book id: flat and inc only, so the order
    /// they are summed in never matters. A weapon it changes is named by id, its place found when
    /// the tuning is read.
    pub per: BTreeMap<String, Vec<SkillMod>>,
}

/// shared/skilltree.json. The order of `nodes` is what a learned set's bits mean on the wire (a kept
/// build names its nodes by id).
#[derive(Deserialize)]
pub struct SkillTreeFile {
    pub nodes: Vec<SkillNode>,
    /// The lines between nodes, by id: [a, b], or [a, b, 1] for one drawn along its orbit (which
    /// only matters to the browser). A node can be learned when it is a root or touches a node
    /// you have learned.
    pub links: Vec<Vec<serde_json::Value>>,
}

/// One node of the tree. Where it is drawn (orbit, angle), its icon and description are only the
/// browser's business.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillNode {
    pub id: String,
    /// skill (one of the skills you use, or one that changes it), small, notable or keystone.
    pub kind: String,
    /// The discipline, or -1 where two meet.
    pub tree: i32,
    pub name: String,
    /// Learnable with nothing else learned.
    #[serde(default)]
    pub root: bool,
    #[serde(default)]
    pub grants: Option<SkillGrants>,
    #[serde(default)]
    pub mods: Vec<SkillMod>,
}

/// What a node grants: a weapon to wield, an ability for the hotbar, a movement skill for a Q / E
/// slot, or a variant of a weapon's combo. The file names each by id (a weapon's is its name); the
/// rules and the wire know them by their places in their lists, found when the tree is read
/// (skill_tree), so the lists can be in any order.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillGrants {
    #[serde(default, rename = "weapon")]
    pub weapon_id: Option<String>,
    /// The weapon's place in shared/tuning.json's weapons.
    #[serde(skip)]
    pub weapon: Option<u8>,
    #[serde(default, rename = "ability")]
    pub ability_id: Option<String>,
    /// The ability's place in its list.
    #[serde(skip)]
    pub ability: Option<u8>,
    /// A movement skill, for a Q / E slot.
    #[serde(default, rename = "movement")]
    pub movement_id: Option<String>,
    /// The movement skill's place in its list.
    #[serde(skip)]
    pub movement: Option<u8>,
    #[serde(default)]
    pub combo: Option<String>,
}

/// One modifier. Everything named must match for it to count; anything absent is a wildcard.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMod {
    pub stat: String,
    pub op: String, // flat | inc | more
    pub value: f64,
    #[serde(default)]
    pub tags: Vec<String>,
    /// The weapon it changes, by id (its name).
    #[serde(default, rename = "weapon")]
    pub weapon_id: Option<String>,
    /// That weapon's place in shared/tuning.json's weapons, found when its file is read.
    #[serde(skip)]
    pub weapon: Option<u8>,
    /// The ability or movement skill it changes, by id.
    #[serde(default)]
    pub skill: Option<String>,
}

impl SkillMod {
    /// Finds the place among `weapons` of the weapon it names; `at` says where the modifier is, for
    /// one naming a weapon there isn't.
    fn place_weapon(&mut self, weapons: &[Weapon], at: &str) {
        self.weapon = self.weapon_id.as_deref().map(|id| place(weapons, |w| &w.name, id, &format!("{at} changes the weapon")));
    }
}

/// A movement skill: an action state with a timeline and a few things that can happen in it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementSkill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Built-in moves everyone has (the slide). No tree node grants them, so they never reach a
    /// Q / E slot, but they run through the same action machine as the rest.
    #[serde(default)]
    pub builtin: bool,
    /// Frames before it can be used again; none if absent (the dodges cost stamina instead).
    #[serde(default)]
    pub cooldown_frames: i32,
    /// Stamina it costs to start, and it can't start without that much.
    #[serde(default)]
    pub stamina_cost: f64,
    pub action: ActionDef,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionDef {
    pub startup: i32,
    pub active: i32,
    pub recovery: i32,
    pub speed: f64,
    /// Eases from `speed` to this across the active frames.
    #[serde(default)]
    pub end_speed: Option<f64>,
    pub direction: String, // input | facing | backward
    /// Radians per second it can be turned; absent means it's committed.
    #[serde(default)]
    pub steer: Option<f64>,
    #[serde(default)]
    pub hold: bool,
    /// Jumping out ends it early and keeps this much of the speed.
    #[serde(default)]
    pub jump_carry: Option<f64>,
    /// A press this many frames early still counts.
    #[serde(default)]
    pub buffer_frames: Option<i32>,
    /// Leaving the ground ends it.
    #[serde(default)]
    pub ground_only: bool,
    #[serde(default)]
    pub invuln_from: Option<i32>,
    #[serde(default)]
    pub invuln_to: Option<i32>,
    #[serde(default)]
    pub damage_taken: Option<f64>,
}

pub const NO_MOVEMENT: u8 = 255;
/// Must match movementSlots in shared/tuning.json (checked when the tuning is loaded).
pub const MOVEMENT_SLOTS: usize = 2;
/// Room for this many movement skills, so the wire size doesn't move every time one is added.
/// Raise it here and in src/content/tuning.ts together when the data outgrows it.
pub const MOVEMENT_SKILL_CAP: usize = 16;

pub fn movement_action(m: u8) -> Option<&'static ActionDef> {
    tuning().movement_skills.get(m as usize).map(|s| &s.action)
}

/// A movement skill's own cooldown, before the tree and its level change it.
pub fn movement_cooldown(m: u8) -> i32 {
    tuning().movement_skills.get(m as usize).map_or(0, |s| s.cooldown_frames)
}

/// Frames before a movement skill can be used again: its own, as the tree and its level change it
/// (movementCooldownFor in src/content/tuning.ts).
pub fn movement_cooldown_for(m: u8, r: &ResolvedSkills) -> i32 {
    channel(r.moves.get(m as usize), stat_movement_cooldown()).frames(movement_cooldown(m))
}

/// Stamina a movement skill costs (a dodge's; the rest cost none), as the tree and its level change
/// it (movementStaminaFor in src/content/tuning.ts).
pub fn movement_stamina_for(m: u8, r: &ResolvedSkills) -> f64 {
    let base = tuning().movement_skills.get(m as usize).map_or(0.0, |s| s.stamina_cost);
    channel(r.moves.get(m as usize), stat_movement_stamina()).apply(base).max(0.0)
}

/// MP an ability costs, as the tree changes it (abilityMpFor in src/content/tuning.ts).
pub fn ability_mp_for(a: u8, r: &ResolvedSkills) -> f64 {
    let base = tuning().abilities.get(a as usize).map_or(0.0, |ab| ab.mp_cost);
    channel(r.ability.get(a as usize), stat_ability_mp()).apply(base).max(0.0)
}

/// The slide everyone has. Looked up by id so reordering the data can't silently rebind it.
pub fn slide_skill() -> u8 {
    static I: OnceLock<u8> = OnceLock::new();
    *I.get_or_init(|| tuning().movement_skills.iter().position(|m| m.id == "slide").expect("shared/tuning.json needs a movement skill with id \"slide\"") as u8)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatDef {
    pub id: String,
    #[serde(default)]
    pub base: f64,
}

#[derive(Deserialize)]
pub struct SkillTree {
    pub name: String,
}

pub const NO_ABILITY: u8 = 255;

/// The combo for a weapon under this build. Resolved when the build changed, not now.
pub fn combo_for(weapon: u8, r: &ResolvedSkills) -> &[AttackStep] {
    r.combo.get(weapon as usize).map_or(&[][..], |v| v.as_slice())
}

fn cached_stat(slot: &'static OnceLock<usize>, id: &'static str) -> usize {
    *slot.get_or_init(|| stat_index(id))
}
fn stat_cast_frames() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "cast.frames")
}
fn stat_melee_targets() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "melee.maxTargets")
}
fn stat_pierce() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "projectile.pierce")
}

/// Effect numbers, resolved through the build. Modifiers reach abilities the same way they reach
/// swings, so a passive that says "area damage" lands here without anything knowing its name.
pub fn effect_radius(a: u8, e: &Effect, r: &ResolvedSkills) -> f64 {
    channel(r.ability.get(a as usize), stat_ability_radius()).apply(e.radius)
}

pub fn effect_damage(a: u8, e: &Effect, r: &ResolvedSkills) -> f64 {
    channel(r.ability.get(a as usize), stat_ability_damage()).apply(e.damage)
}

pub fn effect_amount(a: u8, e: &Effect, r: &ResolvedSkills) -> f64 {
    channel(r.ability.get(a as usize), stat_ability_amount()).apply(e.amount)
}

/// An ability's cooldown after the build's modifiers.
pub fn ability_cooldown(a: u8, r: &ResolvedSkills) -> i32 {
    channel(r.ability.get(a as usize), stat_ability_cooldown()).frames(ability(a).cooldown_frames).max(0)
}

fn stat_ability_radius() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "ability.radius")
}
fn stat_ability_damage() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "ability.damage")
}
fn stat_ability_amount() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "ability.amount")
}
fn stat_ability_cooldown() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "ability.cooldown")
}
fn stat_movement_cooldown() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "movement.cooldown")
}
fn stat_movement_stamina() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "movement.stamina")
}
fn stat_ability_mp() -> usize {
    static I: OnceLock<usize> = OnceLock::new();
    cached_stat(&I, "ability.mp")
}

/// How many enemies one swing of this weapon reaches.
pub fn melee_targets(weapon: u8, r: &ResolvedSkills) -> usize {
    channel(r.weapon.get(weapon as usize), stat_melee_targets()).apply(stat_base(stat_melee_targets())).round().max(1.0) as usize
}

/// How many enemies an arrow from this weapon goes through.
pub fn pierce_targets(weapon: u8, r: &ResolvedSkills) -> usize {
    channel(r.weapon.get(weapon as usize), stat_pierce()).apply(stat_base(stat_pierce())).round().max(1.0) as usize
}

fn channel(list: Option<&Vec<Channel>>, stat: usize) -> Channel {
    list.and_then(|c| c.get(stat)).copied().unwrap_or_default()
}

pub fn ability(a: u8) -> &'static Ability {
    &tuning().abilities[a as usize]
}

pub fn cast_frames_for(a: u8, r: &ResolvedSkills) -> i32 {
    let ab = ability(a);
    channel(r.ability.get(a as usize), stat_cast_frames()).frames(ab.cast_frames).max(1)
}
