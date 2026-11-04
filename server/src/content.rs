//! Actor kinds, read from shared/actors.json - the same file src/content/actors.ts reads. The
//! browser's own fields (species, clips, palette) are simply not declared here; serde skips
//! them, so one file can describe both what a monster is and how it looks.

use std::sync::OnceLock;

use serde::Deserialize;

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
}

#[derive(Deserialize)]
struct File {
    kinds: Vec<ActorKind>,
}

static KINDS: OnceLock<Vec<ActorKind>> = OnceLock::new();

pub fn kinds() -> &'static Vec<ActorKind> {
    KINDS.get_or_init(|| {
        let raw = include_str!("../../shared/actors.json");
        let file: File = serde_json::from_str(raw).expect("shared/actors.json is malformed");
        file.kinds
    })
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
