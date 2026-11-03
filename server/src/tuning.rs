//! Gameplay numbers, read from shared/tuning.json (the same file the browser uses).

use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub sim_hz: f64,
    #[serde(rename = "move")]
    pub movement: Move,
    pub jump: Jump,
    pub slide: Slide,
    pub attack: Attack,
    pub special: SpecialSettings,
    pub weapons: Vec<Weapon>,
    pub abilities: Vec<Ability>,
    pub skills: Skills,
    pub combat: Combat,
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
}

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
pub struct Slide {
    pub speed: f64,
    pub end_speed: f64,
    pub frames: i32,
    pub cooldown_frames: i32,
    pub steer: f64,
    pub jump_carry: f64,
    pub buffer_frames: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attack {
    pub buffer_frames: i32,
    pub air_gravity_scale: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialSettings {
    pub buffer_frames: i32,
    pub cancel_cooldown_frames: i32,
    pub interrupt_cooldown_frames: i32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttackStep {
    pub startup: i32,
    pub active: i32,
    pub recovery: i32,
    pub damage: f64,
    pub lunge: f64,
    pub reach: f64,
    pub arc_deg: f64,
    pub player_knock: f64,
    pub cancel_after: i32,
    #[serde(default)]
    pub projectile_speed: f64, // arrows only
    #[serde(default)]
    pub projectile_range: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Combat {
    pub max_hp: f64,
    pub stun_frames: i32,
    pub knock_up: f64,
    pub down_frames: i32,
}

static TUNING: OnceLock<Tuning> = OnceLock::new();

pub fn tuning() -> &'static Tuning {
    TUNING.get_or_init(|| serde_json::from_str(include_str!("../../shared/tuning.json")).expect("shared/tuning.json is valid"))
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Weapon {
    pub name: String,
    pub combo: Vec<AttackStep>,
    #[serde(default)]
    pub whirlwind: Option<AttackStep>,
    #[serde(default)]
    pub rapid_fire_startup: Option<i32>,
}

/// Healing Circle or Meteor.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ability {
    pub name: String,
    pub kind: String,
    pub cast_frames: i32,
    pub fast_cast_frames: i32,
    pub cooldown_frames: i32,
    pub radius: f64,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub range: f64,
    #[serde(default)]
    pub max_range: Option<f64>,
    #[serde(default)]
    pub fall_frames: i32,
    #[serde(default)]
    pub damage: f64,
    #[serde(default)]
    pub knock: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skills {
    pub points: u32,
    pub cleave_targets: usize,
    pub pierce_targets: usize,
    pub trees: Vec<SkillTree>,
}

#[derive(Deserialize)]
pub struct SkillTree {
    pub name: String,
    pub nodes: Vec<SkillNode>,
}

#[derive(Deserialize)]
pub struct SkillNode {
    pub id: String,
    #[serde(default)]
    pub weapon: Option<u8>,
    #[serde(default)]
    pub ability: Option<u8>,
}

pub const NO_ABILITY: u8 = 255;
pub const CAST_HEAL: u8 = 1;
pub const CAST_METEOR: u8 = 2;

/// Every skill is one bit: tree t, skill n gives bit t * 3 + n, in the order of shared/tuning.json
/// (the same numbering as skillBit in src/tuning.ts).
pub fn skill_bit(id: &str) -> u32 {
    let mut bit = 0;
    for tree in &tuning().skills.trees {
        for node in &tree.nodes {
            if node.id == id {
                return bit;
            }
            bit += 1;
        }
    }
    panic!("unknown skill {id}");
}

pub struct Perks {
    pub cleave: u32,
    pub whirlwind: u32,
    pub rapid_fire: u32,
    pub piercing: u32,
    pub swift_mending: u32,
    pub quick_incantation: u32,
}

static PERKS: OnceLock<Perks> = OnceLock::new();

pub fn perks() -> &'static Perks {
    PERKS.get_or_init(|| Perks {
        cleave: 1 << skill_bit("cleave"),
        whirlwind: 1 << skill_bit("whirlwind"),
        rapid_fire: 1 << skill_bit("rapidFire"),
        piercing: 1 << skill_bit("piercing"),
        swift_mending: 1 << skill_bit("swiftMending"),
        quick_incantation: 1 << skill_bit("quickIncantation"),
    })
}

struct Combos {
    sword_whirlwind: Vec<AttackStep>,
    bow_rapid_fire: Vec<AttackStep>,
}

static COMBOS: OnceLock<Combos> = OnceLock::new();

/// The combo for a weapon, with any skills that change its timing applied.
pub fn combo_for(weapon: u8, perk_bits: u32) -> &'static [AttackStep] {
    let w = &tuning().weapons;
    let c = COMBOS.get_or_init(|| {
        let mut sword_whirlwind = w[0].combo[..2].to_vec();
        sword_whirlwind.push(w[0].whirlwind.clone().expect("sword has a whirlwind hit"));
        let mut bow_rapid_fire = w[3].combo.clone();
        for s in bow_rapid_fire.iter_mut() {
            s.startup = w[3].rapid_fire_startup.expect("bow has a rapid fire draw time");
        }
        Combos { sword_whirlwind, bow_rapid_fire }
    });
    if weapon == 0 && perk_bits & perks().whirlwind != 0 {
        return &c.sword_whirlwind;
    }
    if weapon == 3 && perk_bits & perks().rapid_fire != 0 {
        return &c.bow_rapid_fire;
    }
    &w.get(weapon as usize).unwrap_or(&w[0]).combo
}

pub fn ability(a: u8) -> &'static Ability {
    &tuning().abilities[a as usize]
}

pub fn cast_kind_of(a: u8) -> u8 {
    if ability(a).kind == "heal" { CAST_HEAL } else { CAST_METEOR }
}

pub fn cast_frames_for(a: u8, perk_bits: u32) -> i32 {
    let ab = ability(a);
    let fast = if ab.kind == "heal" { perks().swift_mending } else { perks().quick_incantation };
    if perk_bits & fast != 0 { ab.fast_cast_frames } else { ab.cast_frames }
}

/// Checks a build the browser asked for: no more than the allowed skill points, skills learned
/// top to bottom in each tree, a weapon you've trained, and abilities you've learned.
pub fn valid_build(perk_bits: u32, weapon: u8, ability1: u8, ability2: u8) -> bool {
    let s = &tuning().skills;
    let total: usize = s.trees.iter().map(|t| t.nodes.len()).sum();
    if perk_bits >> total != 0 || perk_bits.count_ones() > s.points {
        return false;
    }
    let mut bit = 0;
    let mut weapon_ok = false;
    let mut learned_abilities = Vec::new();
    for tree in &s.trees {
        for (n, node) in tree.nodes.iter().enumerate() {
            let learned = perk_bits & (1 << bit) != 0;
            if learned && n > 0 && perk_bits & (1 << (bit - 1)) == 0 {
                return false; // skipped a skill above it
            }
            if learned && node.weapon == Some(weapon) {
                weapon_ok = true;
            }
            if let (true, Some(a)) = (learned, node.ability) {
                learned_abilities.push(a);
            }
            bit += 1;
        }
    }
    let slot_ok = |a: u8| a == NO_ABILITY || learned_abilities.contains(&a);
    weapon_ok && slot_ok(ability1) && slot_ok(ability2) && (ability1 != ability2 || ability1 == NO_ABILITY)
}
