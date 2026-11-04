//! Actor kinds, read from shared/actors.json - the same file src/content/actors.ts reads. The
//! browser's own fields (species, clips, palette, scale) are simply not declared here; serde skips
//! them, so one file can describe both what a monster is and how it looks.

use std::sync::OnceLock;

use serde::Deserialize;

/// Dies into this many of another kind.
#[derive(Deserialize, Clone, Debug)]
pub struct Burst {
    pub into: String,
    pub count: usize,
}

/// A slam: when it winds up, how far it jumps, and what it does where it lands.
#[derive(Deserialize, Clone, Debug)]
pub struct SlamDef {
    pub range: f64,
    pub leap: f64,
    pub radius: f64,
    pub damage: f64,
    pub knock: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActorKind {
    pub id: String,
    pub faction: u8,
    pub max_hp: f64,
    pub radius: f64,
    pub hit_height: f64,
    pub hit_ceiling: f64,
    pub solid: bool,
    pub brain: Option<String>,
    /// Frames face-down before it comes back; negative never respawns.
    pub respawn_frames: i32,
    /// For a kind on a ladder: how much of the creature it is.
    #[serde(default)]
    pub mass: f64,
    #[serde(default)]
    pub burst: Option<Burst>,
    #[serde(default)]
    pub slam: Option<SlamDef>,
    /// Whether it can call the pack and gather them in.
    #[serde(default)]
    pub gathers: bool,
}

/// The sizes one creature comes in, smallest first (src/content/actors.ts Ladder).
#[derive(Deserialize, Clone, Debug)]
pub struct Ladder {
    pub id: String,
    pub kinds: Vec<String>,
    pub cap: usize,
    pub fuse: i32,
    pub alone: i32,
}

#[derive(Deserialize)]
struct File {
    kinds: Vec<ActorKind>,
    #[serde(default)]
    ladders: Vec<Ladder>,
}

static FILE: OnceLock<File> = OnceLock::new();

fn file() -> &'static File {
    FILE.get_or_init(|| {
        let raw = include_str!("../../shared/actors.json");
        serde_json::from_str(raw).expect("shared/actors.json is malformed")
    })
}

pub fn kinds() -> &'static Vec<ActorKind> {
    &file().kinds
}

pub fn kind(id: &str) -> Option<&'static ActorKind> {
    kinds().iter().find(|k| k.id == id)
}

/// Index in the shared list, which is how a kind travels on the wire.
pub fn kind_index(id: &str) -> Option<usize> {
    kinds().iter().position(|k| k.id == id)
}

pub fn kind_at(index: usize) -> Option<&'static ActorKind> {
    kinds().get(index)
}

pub fn ladders() -> &'static Vec<Ladder> {
    &file().ladders
}

pub fn ladder_at(index: i32) -> Option<&'static Ladder> {
    if index < 0 {
        return None;
    }
    ladders().get(index as usize)
}

/// Which ladder a kind is on, or -1.
pub fn ladder_of(kind: &str) -> i32 {
    ladders().iter().position(|l| l.kinds.iter().any(|k| k == kind)).map_or(-1, |i| i as i32)
}

/// One size up from `kind`; the top size stays itself.
pub fn size_up(kind: &str) -> String {
    let Some(l) = ladder_at(ladder_of(kind)) else { return kind.to_string() };
    let i = l.kinds.iter().position(|k| k == kind).unwrap_or(0);
    l.kinds[(i + 1).min(l.kinds.len() - 1)].clone()
}

/// The biggest size on a ladder that `mass` reaches, if any.
pub fn size_for(ladder: i32, mass: f64) -> Option<&'static str> {
    let l = ladder_at(ladder)?;
    let mut best = None;
    for id in &l.kinds {
        if kind_mass(id) <= mass {
            best = Some(id.as_str());
        }
    }
    best
}

pub fn kind_mass(id: &str) -> f64 {
    kind(id).map_or(0.0, |k| k.mass)
}
