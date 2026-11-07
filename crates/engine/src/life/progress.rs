//! Getting better (the page reads it through src/engine/life/progress.ts): the skills you use level
//! up, and the tree grows with
//! what you've done.
//!
//! Experience. Each hit a weapon lands, each cast of an ability and each use of a movement skill
//! adds one to that skill (state.skill_xp, kept with your life), and a level comes at each step
//! of the curve in tuning.json skills.levels. A level-up is a quest event too, for the milestones
//! that count them. Online only the server counts: the browser shows what it says.
//!
//! Skill points. Everyone starts with skills.startPoints, and each quest or milestone you finish
//! adds its skillPoints. They're worked out from the quests you've done rather than kept, so they
//! can never drift from them, and finishing a quest that gained points later still counts.

use super::content::quests;
use super::state::LifeState;
use super::{Life, QuestEvent};
use crate::event::Event;
use crate::player::Player;
use crate::skills::{BookKind, book, book_of, level_of, levels_from};
use crate::tuning::tuning;

/// Something the player did that the skill behind it learns from, or a creature they finished
/// off: the events src/engine/life/progress.ts observes.
#[derive(Clone, Copy, Debug)]
pub enum Observed<'a> {
    /// A hit landed with this weapon: a swing, or an arrow it loosed.
    Hit { weapon: u8 },
    /// A cast of this ability finished.
    Cast { ability: u8 },
    /// This movement skill began (the slide everyone has, too).
    Action { id: u8 },
    /// A creature of this kind was finished off.
    Defeat { kind: &'a str },
}

impl<'a> Observed<'a> {
    /// What the life learns from something that happened, if anything: a hit trains the weapon
    /// that dealt it, a cast its ability, a movement skill itself, and a creature finished off
    /// counts for the quests (one that dissolves on its own doesn't).
    pub fn of(e: &'a Event) -> Option<Self> {
        match e {
            Event::Hit { weapon: Some(w), .. } => Some(Observed::Hit { weapon: *w }),
            Event::Cast { ability, .. } => Some(Observed::Cast { ability: *ability }),
            Event::Action { id, .. } => Some(Observed::Action { id: *id }),
            Event::ActorDie { kind, killed: true, .. } => Some(Observed::Defeat { kind }),
            _ => None,
        }
    }
}

/// Which skill in the book (an index into skills::book()) it trains, if any.
pub fn trained_by(e: &Observed) -> Option<usize> {
    match *e {
        Observed::Hit { weapon } => book_of(BookKind::Weapon, weapon),
        Observed::Cast { ability } => book_of(BookKind::Ability, ability),
        Observed::Action { id } => book_of(BookKind::Movement, id),
        Observed::Defeat { .. } => None,
    }
}

/// What a skill in the book is called when it levels up.
pub fn book_name(b: usize) -> String {
    let Some(s) = book().get(b) else { return String::new() };
    let t = tuning();
    let i = s.index as usize;
    match s.kind {
        BookKind::Weapon => t.weapons.get(i).map_or_else(|| s.id.clone(), |w| capital(&w.name)),
        BookKind::Ability => t.abilities.get(i).map_or_else(|| s.id.clone(), |a| a.name.clone()),
        BookKind::Movement => t.movement_skills.get(i).map_or_else(|| s.id.clone(), |m| m.name.clone()),
    }
}

fn capital(t: &str) -> String {
    let mut c = t.chars();
    c.next().map_or_else(String::new, |first| first.to_uppercase().chain(c).collect())
}

/// Adds experience to one skill; a level-up says so and counts for milestones. True if it went up
/// a level (so the player's numbers need working out again).
pub fn train(life: &mut Life, b: usize, amount: f64) -> bool {
    let Some(s) = book().get(b) else { return false };
    let had = life.state.skill_xp.get(s.id.as_str()).copied().unwrap_or(0.0);
    let before = level_of(had);
    let now = had + amount;
    life.state.skill_xp.insert(s.id.clone(), now);
    let after = level_of(now);
    if after <= before {
        return false;
    }
    life.toast(format!("{} reached level {after}", book_name(b)), "good");
    life.notify(QuestEvent { amount: Some(f64::from(after - before)), ..QuestEvent::new("skillLevel") });
    life.revision += 1;
    true
}

/// What the player did goes to the skill behind it, and a creature they finished off to the
/// quests. True if a skill went up a level.
pub fn observe(life: &mut Life, e: Observed) -> bool {
    let levelled = trained_by(&e).is_some_and(|b| train(life, b, 1.0));
    if let Observed::Defeat { kind } = e {
        life.notify(QuestEvent { kind: Some(kind.to_string()), ..QuestEvent::new("defeat") });
    }
    levelled
}

/// Keeps the player's levels (which change what their skills do) in step with the life's
/// experience. Cheap when nothing changed, which is nearly always.
pub fn sync_levels(life: &Life, p: &mut Player) {
    let xp = &life.state.skill_xp;
    let same = book().iter().enumerate().all(|(i, b)| p.levels.get(i).copied().unwrap_or(1) == level_of(xp.get(b.id.as_str()).copied().unwrap_or(0.0)));
    if !same {
        p.set_levels(&levels_from(xp));
    }
}

/// Skill points the quests and milestones you've finished have given you.
pub fn points_earned(state: &LifeState) -> u32 {
    quests().iter().filter_map(|q| q.rewards.skill_points.filter(|&n| n != 0 && state.quests.done.contains(&q.id))).sum()
}

/// How many skill points you may have in the tree in the open world.
pub fn skill_budget(state: &LifeState) -> u32 {
    tuning().skills.start_points + points_earned(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::LifeEvent;
    use crate::life::quests::{complete, quest_active, quest_done, quests_at};
    use crate::life::trade::testing::{new_life, toasts};
    use crate::skills::{book_index, levels_from};
    use crate::tuning::{ability_index, weapon_index};

    /// A weapon's place in the content now.
    fn weapon(id: &str) -> u8 {
        weapon_index(id).unwrap_or_else(|| panic!("no weapon {id}"))
    }

    fn finish_landfall(life: &mut Life) {
        life.notify(QuestEvent { npc: Some("hollis".into()), ..QuestEvent::new("talk") });
        assert!(complete(life, "landfall"));
    }

    #[test]
    fn a_creature_finished_off_is_a_defeat_and_one_that_dissolves_on_its_own_is_not() {
        let die = |killed| Event::ActorDie { id: 7, kind: "slime".into(), x: 0.0, y: 0.0, z: 0.0, killed };
        let (dissolved, finished) = (die(false), die(true));
        assert!(Observed::of(&dissolved).is_none());
        assert!(matches!(Observed::of(&finished), Some(Observed::Defeat { kind: "slime" })));
        // A blast's hit has no weapon: its cast already counted.
        let blast = Event::Hit { index: 0, damage: 12.0, x: 0.0, y: 0.0, z: 0.0, dir_x: 0.0, dir_z: 1.0, weapon: None };
        assert!(Observed::of(&blast).is_none());
    }

    fn counts(life: &Life, id: &str) -> Vec<f64> {
        life.state.quests.active[quest_active(life, id).expect("active")].counts.clone()
    }

    fn xp_curve(level: usize) -> f64 {
        tuning().skills.levels.xp[level]
    }

    #[test]
    fn every_quest_and_milestone_gives_points_and_you_have_what_you_finished() {
        for q in quests() {
            assert!(q.rewards.skill_points.unwrap_or(0) > 0, "{}", q.id);
        }
        let (mut life, _, _) = new_life(0.0);
        let start = tuning().skills.start_points;
        assert_eq!((points_earned(&life.state), skill_budget(&life.state)), (0, start));
        toasts(&mut life);
        finish_landfall(&mut life);
        assert_eq!((points_earned(&life.state), skill_budget(&life.state)), (1, start + 1));
        let said = toasts(&mut life);
        assert!(said.contains(&"✔ Landfall complete - 1 skill point, 50c, Scarecrow, 8 Sunroot Seeds, 6 Barley Seeds".to_string()), "{said:?}");
        // The milestones it opens start quietly.
        assert!(said.iter().all(|t| !t.starts_with("New quest")), "{said:?}");
        // Counted, never kept: a quest done once counts once.
        life.state.quests.done.push("landfall".into());
        life.state.quests.done.extend(["patch".to_string(), "westward".to_string()]);
        assert_eq!(points_earned(&life.state), 1 + 1 + 2);
    }

    #[test]
    fn a_life_saved_before_skills_levelled_reads_and_has_its_points() {
        let (life, _, _) = new_life(0.0);
        let mut old = serde_json::to_value(&life.state).unwrap();
        old.as_object_mut().unwrap().remove("skillXp");
        old["quests"] = serde_json::json!({ "active": [], "done": ["landfall", "patch", "wings"] });
        let s: LifeState = serde_json::from_value(old).unwrap();
        assert!(s.skill_xp.is_empty());
        assert_eq!(points_earned(&s), 3);
        // And experience goes out and comes back exactly as the browser keeps it.
        let mut s = s;
        s.skill_xp.insert("slide".into(), 25.0);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["skillXp"], serde_json::json!({ "slide": 25.0 }));
        let back: LifeState = serde_json::from_str(r#"{"skillXp":{"sword":3,"meteor":120}}"#).unwrap();
        assert_eq!(back.skill_xp.get("meteor"), Some(&120.0));
    }

    #[test]
    fn milestones_start_and_finish_by_themselves() {
        let (mut life, _, _) = new_life(0.0);
        assert!(quest_active(&life, "slimeHunter").is_none());
        finish_landfall(&mut life);
        for id in ["wayfarer", "slimeHunter", "practisedHand"] {
            assert!(quest_active(&life, id).is_some(), "{id}");
        }
        let events = life.drain_events();
        assert!(events.contains(&LifeEvent::Quest { id: "slimeHunter".into(), what: "accepted".into() }));
        let before = skill_budget(&life.state);
        // Only the creature it names counts.
        observe(&mut life, Observed::Defeat { kind: "great-slime" });
        assert_eq!(counts(&life, "slimeHunter"), [0.0]);
        for _ in 0..14 {
            observe(&mut life, Observed::Defeat { kind: "slime" });
        }
        assert_eq!(counts(&life, "slimeHunter"), [14.0]);
        assert!(toasts(&mut life).is_empty());
        observe(&mut life, Observed::Defeat { kind: "slime" });
        assert!(quest_done(&life, "slimeHunter") && quest_active(&life, "slimeHunter").is_none());
        assert_eq!(skill_budget(&life.state), before + 1);
        let events = life.drain_events();
        assert!(events.contains(&LifeEvent::Toast { text: "✔ Milestone: Slime Hunter - 1 skill point".into(), kind: "quest".into() }));
        assert!(events.contains(&LifeEvent::Quest { id: "slimeHunter".into(), what: "done".into() }));
        assert!(!events.iter().any(|e| matches!(e, LifeEvent::Quest { what, .. } if what == "ready")), "never waits to be handed in");
        // Nobody offers them, and nobody takes them in.
        for npc in ["", "hollis"] {
            let (offer, turn_in) = quests_at(&life, npc);
            assert!(offer.iter().chain(turn_in.iter()).all(|q| q.milestone != Some(true)));
        }
    }

    #[test]
    fn skills_level_up_as_you_use_them_and_count_toward_practised_hand() {
        let (mut life, _, mut p) = new_life(0.0);
        finish_landfall(&mut life);
        toasts(&mut life);
        let sword = book_index("sword").unwrap();
        let rev = life.revision;
        assert!(!train(&mut life, sword, xp_curve(1) - 1.0));
        assert_eq!(levels_from(&life.state.skill_xp)[sword], 1);
        assert!(toasts(&mut life).is_empty());
        assert_eq!(life.revision, rev, "experience alone isn't news");
        assert!(observe(&mut life, Observed::Hit { weapon: weapon("sword") }));
        assert_eq!(levels_from(&life.state.skill_xp)[sword], 2);
        assert_eq!(toasts(&mut life), ["Sword reached level 2"]);
        assert_eq!(life.revision, rev + 1);
        assert_eq!(counts(&life, "practisedHand"), [1.0]);
        // The player catches up with the life.
        sync_levels(&life, &mut p);
        assert_eq!(p.levels[sword], 2);
        // A jump of several levels counts them all, and finishes the milestone.
        let had = life.state.skill_xp["sword"];
        train(&mut life, sword, xp_curve(5) - had);
        assert_eq!(levels_from(&life.state.skill_xp)[sword], 6);
        assert!(quest_done(&life, "practisedHand"));
        assert_eq!(toasts(&mut life), ["Sword reached level 6", "✔ Milestone: Practised Hand - 1 skill point"]);
        // The top of the curve is as far as it goes.
        train(&mut life, sword, 1e9);
        assert_eq!(levels_from(&life.state.skill_xp)[sword], crate::skills::max_level());
    }

    #[test]
    fn what_trains_what() {
        assert_eq!(trained_by(&Observed::Hit { weapon: weapon("sword") }), book_index("sword"));
        assert_eq!(trained_by(&Observed::Hit { weapon: weapon("bow") }), book_index("bow"));
        assert_eq!(trained_by(&Observed::Cast { ability: ability_index("meteor").unwrap() }), book_index("meteor"));
        assert_eq!(trained_by(&Observed::Action { id: crate::tuning::slide_skill() }), book_index("slide"));
        assert_eq!(trained_by(&Observed::Defeat { kind: "slime" }), None);
        assert_eq!(trained_by(&Observed::Hit { weapon: 200 }), None);
        let names = [
            ("sword", "Sword"),
            ("club", "Club"),
            ("staff", "Staff"),
            ("bow", "Bow"),
            ("heal", "Healing Circle"),
            ("meteor", "Meteor"),
            ("dodgeRoll", "Dodge Roll"),
            ("backstep", "Backstep"),
            ("block", "Block"),
            ("slide", "Slide"),
        ];
        assert_eq!(book().len(), names.len());
        for (id, name) in names {
            assert_eq!(book_name(book_index(id).unwrap()), name, "{id}");
        }
    }
}
