//! The protocol end to end: a Viewer writing updates from a made-up world and a Heard applying them,
//! over a road that loses, holds back and shuffles them, every state the Heard comes to checked
//! against what the world was that tick (tests/common).

mod common;

use common::{Road, Talk, World, player_field};
use ruina_wire::Ack;
use ruina_wire::heard::Heard;
use ruina_wire::interest::{MID_CAP, NEAR, NEAR_CAP};
use ruina_wire::pack::key;
use ruina_wire::record::{Frame, Intro, Record};
use ruina_wire::schema::{Kind, MAX_FIELDS, Tier};
use ruina_wire::viewer::{View, Viewer, YOU};

const ORIGIN: View = View { x: 0.0, z: 0.0 };

#[test]
fn everything_in_sight_arrives_as_it_was_sent() {
    let mut world = World::new(7, 64, 64, 300.0);
    let mut talk = Talk::new(0, Road::default(), 1);
    for _ in 0..200 {
        world.step();
        talk.tick(&world, ORIGIN);
    }
    assert_eq!(talk.heard.errors, 0);
    assert_eq!(talk.applied, 200);
    assert!(talk.checked > 5_000, "{} states checked", talk.checked);
    talk.settled(&world, ORIGIN, NEAR - 1.0);
    // Everything near is in sight.
    for t in &world.things {
        let (x, z) = (f64::from(t.fields[0]) / 100.0, f64::from(t.fields[1]) / 100.0);
        if x.hypot(z) < NEAR - 1.0 && t.intro.kind() != Kind::Arrow {
            assert!(talk.heard.ents.values().any(|e| World::key_of(&e.intro) == t.key), "{:?} at ({x:.0}, {z:.0}) is in sight", t.intro);
        }
    }
    talk.agree(&world);
}

#[test]
fn once_acknowledged_only_what_changed_goes() {
    // A still world: the first update introduces everyone; once that's acknowledged, nothing more.
    let mut world = World::new(11, 40, 40, 70.0);
    world.busy = 0.0;
    let mut talk = Talk::new(0, Road::default(), 2);
    talk.tick(&world, ORIGIN);
    let first = talk.viewer.stats;
    assert!(first.intros >= 40, "{first:?}");
    for _ in 0..3 {
        talk.tick(&world, ORIGIN);
    }
    // Nothing moved and no time passed: header and counts only.
    assert_eq!(talk.viewer.stats.records, 0, "{:?}", talk.viewer.stats);
    assert!(talk.viewer.stats.bytes <= 13, "{:?}", talk.viewer.stats);
    // Moving, each moving thing is a few bytes.
    world.busy = 1.0;
    world.step();
    talk.tick(&world, ORIGIN);
    let moving = talk.viewer.stats;
    assert!(moving.records > 0);
    let per = (moving.bytes - 13) as f64 / moving.records as f64;
    assert!(per < 12.0, "{per:.1} bytes a moving record ({moving:?}); the first update's were {:.1}", first.bytes as f64 / first.records as f64);
}

#[test]
fn a_swing_in_progress_costs_nothing_until_it_ends() {
    let frame_at = |tick: u64, swing: i32, mode: i32| {
        let mut f = [0; MAX_FIELDS];
        // What isn't going is -1, as the packer writes it; the frames since landing and taking off at their cap.
        for name in ["castFrame", "actionFrame", "flipFrame", "downFrame"] {
            f[player_field(name)] = -1;
        }
        f[player_field("landFrame")] = 999;
        f[player_field("takeoffFrame")] = 999;
        f[player_field("attackFrame")] = swing;
        f[player_field("mode")] = mode;
        f[player_field("hp")] = 10_000;
        let mut frame = Frame::new(tick);
        frame.push(Record {
            key: key(Kind::Player, 5),
            owner: key(Kind::Player, 5),
            intro: Intro::Player { id: 5, name: "Bo".into(), bot: false },
            fields: f,
            refers: 0,
        });
        frame
    };
    let mut v = Viewer::new(0);
    let mut heard = Heard::new();
    let mut sizes = Vec::new();
    for (k, (swing, mode)) in [(-1, 0), (0, 1), (3, 1), (6, 1), (9, 1), (12, 1), (-1, 0), (-1, 0)].into_iter().enumerate() {
        let bytes = v.update(&frame_at(100 + k as u64, swing, mode), ORIGIN, &[]);
        heard.hear(&bytes).unwrap().unwrap();
        v.ack(&heard.ack());
        sizes.push((v.stats.records, bytes.len()));
        // As heard, run on to now.
        let bo = heard.ents.values().next().unwrap().now();
        let frame = player_field("attackFrame");
        let ticks = (100 + k as u32).wrapping_sub(bo.tick);
        assert_eq!(ruina_wire::schema::PLAYER[frame].run.guess(bo.fields[frame], ticks), swing);
    }
    // In: the whole record. Starting the swing: its frame and mode. Running on as guessed: nothing at
    // all (the browser runs it on itself). Ending it: frame and mode. Then nothing.
    assert_eq!(sizes[1].0, 1);
    for s in &sizes[2..6] {
        assert_eq!(*s, (0, 13), "a swing running on costs nothing: {sizes:?}");
    }
    assert_eq!(sizes[6].0, 1, "{sizes:?}");
    assert_eq!(sizes[7], (0, 13), "{sizes:?}");
}

#[test]
fn lost_shuffled_and_late_updates_change_nothing_that_is_heard() {
    let mut world = World::new(23, 120, 80, 260.0);
    let road = Road { lose: 0.2, hold: 0.15, ack_every: 2, delay: 2 };
    let mut talk = Talk::new(0, road, 3);
    let mut view = ORIGIN;
    for t in 0..600 {
        world.step();
        view.x = (f64::from(t) * 0.05).sin() * 40.0;
        talk.tick(&world, view);
    }
    assert_eq!(talk.heard.errors, 0, "no update named a baseline the Heard didn't have");
    assert!(talk.heard.stale > 10, "some arrived after a newer one: {}", talk.heard.stale);
    assert!(talk.applied > 300, "{} of 600 applied", talk.applied);
    // A quiet road again, and everything near settles to exactly what the world is.
    talk.road = Road { ack_every: 1, ..Road::default() };
    for _ in 0..10 {
        world.step();
        talk.tick(&world, view);
    }
    assert_eq!(talk.heard.errors, 0);
    talk.agree(&world);
    talk.settled(&world, view, NEAR - 1.0);
}

#[test]
fn an_update_older_than_the_newest_is_dropped_and_not_acknowledged() {
    let mut world = World::new(5, 10, 10, 50.0);
    let mut v = Viewer::new(0);
    let mut updates = Vec::new();
    for _ in 0..3 {
        world.step();
        updates.push(v.update(&world.frame(), ORIGIN, &[]));
    }
    let mut heard = Heard::new();
    assert!(heard.hear(&updates[0]).unwrap().is_some());
    // The third overtakes the second: the second arrives stale.
    assert!(heard.hear(&updates[2]).unwrap().is_some() || heard.errors > 0);
    assert_eq!(heard.errors, 0, "the third measures against the first, which arrived");
    assert!(heard.hear(&updates[1]).unwrap().is_none());
    assert_eq!(heard.stale, 1);
    assert_eq!(heard.ack(), Ack { seq: 3, bits: 0b10 }, "3 and 1 applied, 2 not");
    // The viewer learns 2 was lost: what it carried isn't anyone's baseline.
    v.ack(&heard.ack());
    assert_eq!(v.in_flight(), 0);
}

#[test]
fn the_budget_is_held_and_the_nearest_go_first() {
    // 2000 players within 60 m: far more than a tick's budget.
    let mut world = World::new(31, 2000, 0, 120.0);
    world.things.retain(|t| t.intro.kind() == Kind::Player);
    let mut talk = Talk::new(0, Road::default(), 4);
    let per_tick = talk.viewer.budget.bytes_per_second / talk.viewer.budget.ticks_per_second;
    let burst = per_tick * talk.viewer.budget.burst_ticks;
    let mut first_in = Vec::new();
    for t in 0..120 {
        world.step();
        talk.tick(&world, ORIGIN);
        let s = talk.viewer.stats;
        assert!((s.bytes as f64) <= burst + 64.0, "update {t}: {} bytes, budget {burst}", s.bytes);
        if t == 0 {
            first_in = talk.heard.ents.values().filter(|e| e.kind() == Kind::Player).map(|e| World::key_of(&e.intro)).collect();
        }
    }
    // Over the run, the average stays within the budget.
    let average = talk.sent_bytes as f64 / talk.updates as f64;
    assert!(average <= per_tick * 1.02, "{average:.0} bytes an update against {per_tick:.0}");
    // The first in were the nearest.
    let d = |k: &u64| {
        let t = world.find(*k).unwrap();
        (f64::from(t.fields[0]) / 100.0).hypot(f64::from(t.fields[1]) / 100.0)
    };
    let nearest_first = first_in.iter().map(d).fold(0.0, f64::max);
    assert!(nearest_first < NEAR + 15.0, "the first in were within {nearest_first:.0} m");
    // In time everyone the caps allow is in sight.
    let in_sight = talk.heard.ents.len();
    assert!(in_sight >= NEAR_CAP + MID_CAP, "{in_sight} in sight");
    assert_eq!(talk.heard.errors, 0);
}

#[test]
fn a_handle_is_given_again_only_once_its_end_is_acknowledged() {
    // Something that comes and goes from sight every few ticks, its removals sometimes lost.
    let mut world = World::new(41, 30, 30, 50.0);
    let road = Road { lose: 0.3, hold: 0.0, ack_every: 1, delay: 1 };
    let mut talk = Talk::new(0, road, 5);
    for t in 0..400 {
        world.step();
        // The view jumps between two places 400 m apart: everything leaves sight and comes back.
        let view = if (t / 7) % 2 == 0 { ORIGIN } else { View { x: 400.0, z: 0.0 } };
        talk.tick(&world, view);
        // No handle is in sight twice, and nothing in sight is named by a handle given to another.
        let mut keys: Vec<u64> = talk.heard.ents.values().map(|e| World::key_of(&e.intro)).collect();
        let n = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), n, "tick {t}: one entity under two handles");
    }
    assert_eq!(talk.heard.errors, 0);
}

#[test]
fn a_crowd_of_thousands_over_a_bad_road() {
    let mut world = World::new(97, 3000, 1000, 700.0);
    let road = Road { lose: 0.05, hold: 0.05, ack_every: 1, delay: 3 };
    let mut talk = Talk::new(key(Kind::Player, 2), road, 6);
    let mut view = ORIGIN;
    for t in 0..300 {
        world.step();
        view.x = f64::from(t) * 0.4 - 60.0;
        view.z = (f64::from(t) * 0.02).sin() * 50.0;
        talk.tick(&world, view);
    }
    assert_eq!(talk.heard.errors, 0);
    assert!(talk.checked > 50_000, "{} states checked", talk.checked);
    let average = talk.sent_bytes as f64 / talk.updates as f64;
    let per_tick = talk.viewer.budget.bytes_per_second / talk.viewer.budget.ticks_per_second;
    assert!(average <= per_tick * 1.02, "{average:.0} bytes an update");
    // Player 2 is the viewer's own: never sent to it.
    assert!(!talk.heard.ents.values().any(|e| World::key_of(&e.intro) == key(Kind::Player, 2)));
}

#[test]
fn a_reset_starts_both_sides_over() {
    let mut world = World::new(3, 20, 20, 60.0);
    let mut talk = Talk::new(0, Road::default(), 7);
    for _ in 0..5 {
        world.step();
        talk.tick(&world, ORIGIN);
    }
    let before = talk.heard.ents.len();
    assert!(before > 0);
    talk.viewer.reset();
    talk.heard.reset();
    for _ in 0..5 {
        world.step();
        talk.tick(&world, ORIGIN);
    }
    assert_eq!(talk.heard.errors, 0);
    assert_eq!(talk.heard.ents.len(), before);
}

#[test]
fn your_own_things_come_with_your_own_state_but_your_arrows_come_here() {
    let me = key(Kind::Player, 1);
    let mut frame = Frame::new(50);
    let mut f = [0; MAX_FIELDS];
    f[0] = 100;
    let mine = |intro: Intro, k: u64| Record { key: k, owner: me, intro, fields: f, refers: me };
    frame.push(mine(Intro::Player { id: 1, name: "Me".into(), bot: false }, me));
    frame.push(mine(Intro::Vehicle { owner: 1, id: 3, def: 0 }, ruina_wire::pack::owned_key(Kind::Vehicle, 1, 3)));
    frame.push(mine(Intro::Item { owner: 1, id: 4, def: 0 }, ruina_wire::pack::owned_key(Kind::Item, 1, 4)));
    frame.push(mine(Intro::Arrow { id: 9 }, key(Kind::Arrow, 9)));
    let mut v = Viewer::new(me);
    let mut heard = Heard::new();
    heard.hear(&v.update(&frame, ORIGIN, &[])).unwrap();
    let kinds: Vec<Kind> = heard.ents.values().map(|e| e.kind()).collect();
    assert_eq!(kinds, [Kind::Arrow]);
    // Its owner is you.
    let arrow = heard.ents.values().next().unwrap();
    assert_eq!(arrow.now().fields[6], i32::from(YOU));
}

#[test]
fn vehicles_go_when_their_owners_do() {
    // A player 80 m off (mid: every fourth tick) driving their cart: the two always in the same update.
    let mut world = World::new(13, 1, 0, 1.0);
    world.things.retain(|t| t.intro.kind() != Kind::Item);
    let rider = world.things[0].key;
    for t in world.things.iter_mut() {
        t.fields[0] += 8000;
        t.vx = 0.2;
    }
    let cart = world.things.iter().position(|t| t.intro.kind() == Kind::Vehicle).unwrap();
    world.things[cart].vx = 0.2;
    let mut talk = Talk::new(0, Road::default(), 8);
    let mut together = 0;
    for _ in 0..40 {
        world.step();
        let cart_x = world.things[cart].fields[0];
        world.things[cart].fields[0] = cart_x + 20;
        talk.tick(&world, ORIGIN);
        let fresh: Vec<Kind> = talk.heard.ents.values().filter(|e| e.now().seq == talk.viewer.seq()).map(|e| e.kind()).collect();
        if !fresh.is_empty() {
            assert_eq!(fresh.len(), 2, "rider and cart together: {fresh:?}");
            together += 1;
        }
    }
    assert!((9..=12).contains(&together), "every fourth tick or so: {together}");
    assert!(talk.heard.ents.values().all(|e| e.tier == Tier::Mid));
    assert!(world.find(rider).is_some());
}
