//! Where a player stands to start with, or gets back up: a spot and the way to face there. The spots
//! themselves are data, never the rules': a region's spawn (its recipe, `content/regions/<id>.json`)
//! and an instance's arrival (its file, `content/instances/<id>.json`), which the world a player is
//! stepped in answers (crate::open::OpenWorld::spawn_point).

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spawn {
    pub x: f64,
    pub z: f64,
    pub facing: f64,
}
