//! The order the content lists its weapons, abilities and movement skills in (content/weapons/_order.json
//! and the others) changes nothing the rules decide. The engine reads the tuning here with each of
//! those lists the other way round, as contentc builds it from orders reversed: the skill tree and the
//! levels name what they grant and change by id, and a kept build names what it holds by id, so each
//! is found wherever the list now has it. Each file in tests/ is a test program of its own, so this
//! one's bundles are its alone. tests/unit/weaponOrder.test.ts does the same for the page.

use std::collections::BTreeMap;
use std::sync::Once;

use ruina_engine::bundles;
use ruina_engine::player::Build;
use ruina_engine::skills::{
    BookKind, allowed, book, book_of, build_from_saved, levels_from, nodes, resolve_skills, saved_build, skills_from, stat_index, valid_build, valid_movement,
};
use ruina_engine::tuning::{
    HOTBAR_SLOTS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, ability_index, cast_frames_for, combo_for, melee_targets, movement_index, movement_stamina_for,
    pierce_targets, tuning, weapon_index,
};
use serde_json::{Value, json};

/// Gives the engine the tuning with its weapons, abilities and movement skills each in the opposite
/// order, before anything has read it; every test here starts with it.
fn reversed() {
    static GIVEN: Once = Once::new();
    GIVEN.call_once(|| {
        let mut t: Value = serde_json::from_str(include_str!("../../../shared/tuning.json")).expect("shared/tuning.json");
        let mut before = Vec::new();
        for key in ["weapons", "abilities", "movementSkills"] {
            let list = t[key].as_array_mut().expect("a list");
            before.push(list.len());
            list.reverse();
        }
        assert!(before.iter().all(|&n| n >= 2), "each list has at least two things to reorder");
        assert!(bundles::give(BTreeMap::from([("tuning.json".to_string(), t.to_string())])), "nothing has read the tuning yet");
    });
}

fn weapon(id: &str) -> u8 {
    weapon_index(id).unwrap_or_else(|| panic!("no weapon {id}"))
}
fn ability(id: &str) -> u8 {
    ability_index(id).unwrap_or_else(|| panic!("no ability {id}"))
}
fn movement(id: &str) -> u8 {
    movement_index(id).unwrap_or_else(|| panic!("no movement skill {id}"))
}

#[test]
fn the_lists_are_the_other_way_round() {
    reversed();
    let t = tuning();
    assert_eq!(t.weapons.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), ["bow", "staff", "club", "sword"]);
    assert_eq!(t.abilities.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["meteor", "heal"]);
    assert_eq!(t.movement_skills.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["slide", "block", "backstep", "dodgeRoll"]);
}

#[test]
fn the_tree_grants_and_changes_what_it_names_wherever_it_is() {
    reversed();
    let t = tuning();
    let mut grants = 0;
    for n in nodes() {
        if let Some(g) = &n.grants {
            assert_eq!(g.weapon.map(|w| t.weapons[w as usize].name.as_str()), g.weapon_id.as_deref(), "{}", n.id);
            assert_eq!(g.ability.map(|a| t.abilities[a as usize].id.as_str()), g.ability_id.as_deref(), "{}", n.id);
            assert_eq!(g.movement.map(|m| t.movement_skills[m as usize].id.as_str()), g.movement_id.as_deref(), "{}", n.id);
            grants += 1;
        }
        for m in &n.mods {
            assert_eq!(m.weapon.map(|w| t.weapons[w as usize].name.as_str()), m.weapon_id.as_deref(), "{}", n.id);
        }
    }
    assert_eq!(grants, 10, "four weapons, two abilities, three movement skills and a combo variant");
    // Each weapon skill lets you wield its weapon, and no other.
    let bar = [NO_ABILITY; HOTBAR_SLOTS];
    for id in ["sword", "club", "staff", "bow"] {
        assert!(valid_build(&skills_from(&[id]), weapon(id), &bar, 1), "{id}");
        let other = if id == "sword" { "club" } else { "sword" };
        assert!(!valid_build(&skills_from(&[id]), weapon(other), &bar, 1), "{id} wielding a {other}");
    }
    // An ability or a movement skill learned is the one its node names, for the hotbar and Q / E.
    let mut hotbar = bar;
    hotbar[0] = ability("heal");
    assert!(valid_build(&skills_from(&["club", "heal"]), weapon("club"), &hotbar, 2));
    hotbar[0] = ability("meteor");
    assert!(!valid_build(&skills_from(&["club", "heal"]), weapon("club"), &hotbar, 2), "Meteor not learned");
    assert!(valid_movement(&skills_from(&["club", "block"]), &[movement("block"), NO_MOVEMENT]));
    assert!(!valid_movement(&skills_from(&["club", "block"]), &[movement("dodgeRoll"), NO_MOVEMENT]), "Dodge Roll not learned");
}

#[test]
fn a_new_character_holds_the_weapon_its_first_skill_grants() {
    reversed();
    let b = Build::default();
    assert_eq!(tuning().weapons[b.weapon as usize].name, "sword");
    assert!(allowed(&b, tuning().skills.start_points), "a new character's build is one the tree allows");
}

#[test]
fn modifiers_and_levels_reach_what_they_name() {
    reversed();
    let startup = stat_index("attack.startup");
    let rapid = resolve_skills(&skills_from(&["bow", "rapidFire"]), &[]);
    for w in &tuning().weapons {
        let more = rapid.weapon[weapon(&w.name) as usize][startup].more;
        assert_eq!(more < 1.0, w.name == "bow", "Rapid Fire draws the bow faster, and nothing else: {}", w.name);
    }
    assert_eq!(combo_for(weapon("bow"), &rapid)[0].startup, 6, "a third faster: 9 frames of draw become 6");
    let cleave = resolve_skills(&skills_from(&["sword", "cleave"]), &[]);
    assert_eq!((melee_targets(weapon("sword"), &cleave), melee_targets(weapon("club"), &cleave)), (6, 1));
    let piercer = resolve_skills(&skills_from(&["bow", "rapidFire", "piercing"]), &[]);
    assert_eq!(pierce_targets(weapon("bow"), &piercer), 3);
    let mender = resolve_skills(&skills_from(&["club", "heal", "swiftMending"]), &[]);
    assert_eq!((cast_frames_for(ability("heal"), &mender), cast_frames_for(ability("meteor"), &mender)), (14, 72));
    // A level is kept by its skill's id and adds to that skill alone.
    let xp = BTreeMap::from([("sword".to_string(), 200.0), ("dodgeRoll".to_string(), 900.0)]);
    let levels = levels_from(&xp);
    assert_eq!(levels[book_of(BookKind::Weapon, weapon("sword")).unwrap()], 5);
    assert_eq!(levels[book_of(BookKind::Movement, movement("dodgeRoll")).unwrap()], 10);
    let s = skills_from(&["sword", "club", "dodgeRoll"]);
    let (plain, trained) = (resolve_skills(&s, &[]), resolve_skills(&s, &levels));
    let damage = |r, w| combo_for(weapon(w), r)[0].damage;
    let sword = tuning().weapons[weapon("sword") as usize].combo[0].damage;
    assert_eq!(damage(&trained, "sword"), sword * (1.0 + 0.03 * 4.0));
    assert_eq!(damage(&trained, "club"), damage(&plain, "club"));
    let dodge = movement("dodgeRoll");
    assert_eq!(movement_stamina_for(dodge, &trained), tuning().movement_skills[dodge as usize].stamina_cost * (1.0 - 0.03 * 9.0));
    // The book lists each weapon under the node that grants it, and each ability and movement skill
    // under its own id, in the lists' order.
    let ids: Vec<(&str, u8)> = book().iter().map(|b| (b.id.as_str(), b.index)).collect();
    assert_eq!(&ids[..4], [("bow", weapon("bow")), ("staff", weapon("staff")), ("club", weapon("club")), ("sword", weapon("sword"))]);
}

#[test]
fn a_kept_build_means_what_it_always_meant() {
    reversed();
    // Kept by id: what it names, wherever the lists have it.
    let kept = json!({ "weapon": "club", "skills": ["club", "heal", "block"], "abilities": [null, null, "heal"], "movement": [null, "block"] });
    let b = build_from_saved(&kept).expect("a build");
    assert_eq!((b.weapon, b.abilities[2], b.movement[1]), (weapon("club"), ability("heal"), movement("block")));
    assert!(allowed(&b, 3));
    assert_eq!(saved_build(&b)["weapon"], "club");
    // Kept by index, as builds were before, in the order they were kept in (shared/buildsByIndex.json):
    // the bow, Meteor and Healing Circle on the bar, Block and Dodge Roll on Q and E.
    let old = json!({ "skills": [32767, 0, 0, 0, 0, 0, 0, 0], "weapon": 3, "movement": [2, 0], "abilities": [255, 255, 255, 255, 1, 255, 255, 0] });
    let b = build_from_saved(&old).expect("a build");
    assert_eq!(b.weapon, weapon("bow"));
    assert_eq!((b.abilities[4], b.abilities[7]), (ability("meteor"), ability("heal")));
    assert_eq!(b.movement, [movement("block"), movement("dodgeRoll")]);
    assert_eq!(b.abilities.len(), HOTBAR_SLOTS);
    assert_eq!(b.movement.len(), MOVEMENT_SLOTS);
    assert!(allowed(&b, 15));
}
