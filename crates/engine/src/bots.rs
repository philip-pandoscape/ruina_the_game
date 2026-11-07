//! Bots: players whose inputs come from a brain instead of a keyboard. Whoever runs the world steps
//! a bot exactly as it steps a player (a bot has a `Player`, and in the open world no life of its
//! own): each step the bot's brain looks at what it can see and decides what it presses, as
//! `Actions`, the same thing a browser's key presses become. So every rule a player is held to holds
//! a bot too, and a bot can stand in for a player anywhere: a battlefield's armies, a developer's
//! sparring partner, one day townsfolk who play the game around you.
//!
//! The brains, so far:
//! - a skirmisher finds the nearest foe it can see, closes in, strikes when it's in reach, and backs
//!   off while it's badly hurt; with nobody to fight it wanders.
//! - a wanderer walks between places near home, stopping a while at each.

use serde::{Deserialize, Serialize};

use crate::jsmath::{JsMath, len};
use crate::player::{Actions, Mode, Player};
use crate::rng::Rng;
use crate::tuning::tuning;

/// What a bot can see of one foe.
#[derive(Clone, Copy, Debug)]
pub struct FoeSeen {
    pub x: f64,
    pub z: f64,
    pub hp: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Brain {
    Skirmisher,
    Wanderer,
}

impl Brain {
    /// A brain by its name in content ("skirmisher", "wanderer").
    pub fn named(name: &str) -> Option<Brain> {
        match name {
            "skirmisher" => Some(Brain::Skirmisher),
            "wanderer" => Some(Brain::Wanderer),
            _ => None,
        }
    }
}

/// How far a bot sees a foe, in metres.
pub const SIGHT: f64 = 40.0;
/// Close enough to strike: a little inside a sword's reach, so a swing lands.
const STRIKE_AT: f64 = 1.8;
/// Below this share of its health a skirmisher backs off, until it's back above RALLY_AT.
const HURT_AT: f64 = 0.3;
const RALLY_AT: f64 = 0.6;
/// How far from home a bot wanders.
const WANDER: f64 = 12.0;

/// A bot's brain and what it has in mind, read and written whole where its player is handed between
/// simulations (crate::border).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bot {
    pub brain: Brain,
    rng: Rng,
    /// Where it wanders round.
    home: (f64, f64),
    /// Where it's walking, if anywhere.
    goal: Option<(f64, f64)>,
    /// Steps it waits before setting off again.
    idle: i32,
    /// Backing off from a fight.
    retreating: bool,
    /// Steps since its last swing.
    since_swing: i32,
}

impl Bot {
    pub fn new(brain: Brain, seed: u32, home: (f64, f64)) -> Self {
        Bot { brain, rng: Rng::new(seed), home, goal: None, idle: 0, retreating: false, since_swing: 0 }
    }

    /// What it presses this step, as `me`, seeing `foes` (anyone it fights, near or far: it looks
    /// for itself).
    pub fn think(&mut self, me: &Player, foes: &[FoeSeen]) -> Actions {
        self.since_swing += 1;
        if me.mode == Mode::Swim || me.hp <= 0.0 {
            return Actions::default();
        }
        if self.brain == Brain::Skirmisher {
            let health = me.hp / tuning().combat.max_hp;
            if health < HURT_AT {
                self.retreating = true;
            } else if health > RALLY_AT {
                self.retreating = false;
            }
            let nearest = foes
                .iter()
                .filter(|f| f.hp > 0.0)
                .map(|f| (len(f.x - me.pos.x, f.z - me.pos.z), f))
                .filter(|(d, _)| *d <= SIGHT)
                .min_by(|a, b| a.0.total_cmp(&b.0));
            if let Some((d, foe)) = nearest {
                return self.fight(me, foe, d);
            }
        }
        self.wander(me)
    }

    fn fight(&mut self, me: &Player, foe: &FoeSeen, d: f64) -> Actions {
        let (dx, dz) = ((foe.x - me.pos.x) / d.max(1e-6), (foe.z - me.pos.z) / d.max(1e-6));
        let mut a = Actions { face_x: dx, face_z: dz, ..Actions::default() };
        if self.retreating {
            a.move_x = -dx;
            a.move_z = -dz;
            a.sprint_held = true;
        } else if d > STRIKE_AT {
            a.move_x = dx;
            a.move_z = dz;
            a.sprint_held = d > 8.0;
        } else if self.since_swing >= 12 + (self.rng.next_f64() * 12.0) as i32 {
            // In reach: swing, now and then rather than every step, as a person would.
            a.attack_pressed = true;
            self.since_swing = 0;
        }
        a
    }

    fn wander(&mut self, me: &Player) -> Actions {
        if self.idle > 0 {
            self.idle -= 1;
            return Actions::default();
        }
        let (gx, gz) = match self.goal {
            Some(g) => g,
            None => {
                let angle = self.rng.next_f64() * std::f64::consts::TAU;
                // Somewhere worth the walk: at least a couple of metres off.
                let r = 2.0 + (WANDER - 2.0) * self.rng.next_f64().sqrt();
                let g = (self.home.0 + angle.js_sin() * r, self.home.1 + angle.js_cos() * r);
                self.goal = Some(g);
                g
            }
        };
        let d = len(gx - me.pos.x, gz - me.pos.z);
        if d < 0.8 {
            self.goal = None;
            self.idle = 60 + (self.rng.next_f64() * 120.0) as i32;
            return Actions::default();
        }
        Actions { move_x: (gx - me.pos.x) / d, move_z: (gz - me.pos.z) / d, ..Actions::default() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::Build;
    use crate::world::Spawn;

    fn at(x: f64, z: f64) -> Player {
        Player::new(Spawn { x, z, facing: 0.0 }, 0, Build::default())
    }

    #[test]
    fn a_skirmisher_closes_in_and_faces_its_foe() {
        let mut bot = Bot::new(Brain::Skirmisher, 1, (0.0, 0.0));
        let a = bot.think(&at(0.0, 0.0), &[FoeSeen { x: 0.0, z: 10.0, hp: 100.0 }]);
        assert!(a.move_z > 0.99 && a.move_x.abs() < 1e-9);
        assert!(a.face_z > 0.99);
        assert!(!a.attack_pressed);
    }

    #[test]
    fn in_reach_it_strikes_now_and_then_and_stands_its_ground() {
        let mut bot = Bot::new(Brain::Skirmisher, 1, (0.0, 0.0));
        let me = at(0.0, 0.0);
        let foe = [FoeSeen { x: 0.0, z: 1.5, hp: 100.0 }];
        let presses: Vec<Actions> = (0..60).map(|_| bot.think(&me, &foe)).collect();
        let swings = presses.iter().filter(|a| a.attack_pressed).count();
        assert!((2..=5).contains(&swings), "{swings} swings in a second");
        assert!(presses.iter().all(|a| a.move_x == 0.0 && a.move_z == 0.0));
    }

    #[test]
    fn badly_hurt_it_backs_off_until_it_has_recovered() {
        let mut bot = Bot::new(Brain::Skirmisher, 1, (0.0, 0.0));
        let mut me = at(0.0, 0.0);
        let foe = [FoeSeen { x: 0.0, z: 3.0, hp: 100.0 }];
        me.hp = tuning().combat.max_hp * 0.2;
        assert!(bot.think(&me, &foe).move_z < -0.99);
        // Better, but not yet rallied: still backing off.
        me.hp = tuning().combat.max_hp * 0.5;
        assert!(bot.think(&me, &foe).move_z < -0.99);
        me.hp = tuning().combat.max_hp * 0.7;
        assert!(bot.think(&me, &foe).move_z > 0.99);
    }

    #[test]
    fn it_ignores_foes_out_of_sight_and_the_fallen_and_wanders() {
        let mut bot = Bot::new(Brain::Skirmisher, 1, (0.0, 0.0));
        let a = bot.think(&at(0.0, 0.0), &[FoeSeen { x: 0.0, z: SIGHT + 5.0, hp: 100.0 }, FoeSeen { x: 1.0, z: 0.0, hp: 0.0 }]);
        assert!(!a.attack_pressed && a.face_x == 0.0 && a.face_z == 0.0);
        assert!(len(a.move_x, a.move_z) > 0.99, "walking somewhere");
    }

    #[test]
    fn a_wanderer_walks_near_home_and_the_same_seed_walks_the_same_way() {
        let walk = |seed| {
            let mut bot = Bot::new(Brain::Wanderer, seed, (5.0, 5.0));
            let mut me = at(5.0, 5.0);
            let mut far = 0.0f64;
            for _ in 0..2000 {
                let a = bot.think(&me, &[]);
                me.pos.x += a.move_x * 0.1;
                me.pos.z += a.move_z * 0.1;
                far = far.max(len(me.pos.x - 5.0, me.pos.z - 5.0));
            }
            (me.pos.x, me.pos.z, far)
        };
        let (x, z, far) = walk(7);
        assert!(far > 1.0 && far <= WANDER + 1.0, "{far}");
        assert_eq!((x, z, far), walk(7));
        assert_ne!((x, z), (walk(8).0, walk(8).1));
    }
}
