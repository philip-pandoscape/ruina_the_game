//! Everything in the world that is not a player: monsters, NPCs, props. Mirrors src/sim/actor.ts
//! field for field, because the browser runs the same rules offline in the training yard and the
//! two have to agree.

use crate::content::{ActorKind, kind, kind_index, kind_mass, ladder_of};

pub const FACTION_HOSTILE: u8 = 1;

#[derive(Clone, Debug)]
pub struct Actor {
    pub id: u32,
    pub kind: String,
    pub faction: u8,

    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub facing: f64,

    pub radius: f64,
    pub hit_height: f64,
    pub hit_ceiling: f64,
    pub solid: bool,

    pub hp: f64,
    pub max_hp: f64,
    pub flash_frame: i32,
    /// -1 while alive, otherwise frames since it died.
    pub dead_frame: i32,

    pub brain: Option<String>,
    pub state: usize,
    pub state_frame: i32,
    pub wait: i32,
    pub move_x: f64,
    pub move_z: f64,
    pub home_x: f64,
    pub home_z: f64,
    pub seed: u32,

    pub lean_x: f64,
    pub lean_z: f64,
    pub lean_vx: f64,
    pub lean_vz: f64,

    /// Index of this actor's kind in shared/actors.json, for the wire.
    pub kind_index: u8,
    /// Its home kind's: a home actor comes back as what it was spawned as.
    pub respawn_frames: i32,

    // ---- creatures that come in sizes (shared/actors.json ladders) ----
    pub mass: f64,
    pub ladder: i32,
    /// Made during a fight: cleared away when it dies, never respawns.
    pub transient: bool,
    pub home_kind: String,
    /// Taken out of the world without dying (absorbed, merged): waiting to respawn.
    pub gone: bool,

    // ---- what its brain is up to with the others ----
    pub angry: i32,
    pub slam_cd: i32,
    pub gather_cd: i32,
    /// The caller it is rallying to, or 0.
    pub rally_to: u32,
    /// Frames since it started calling the pack, or -1.
    pub calling: i32,
    /// Damage taken since its current cast began.
    pub taken: f64,
    /// Frames left on its burst group's fuse (or, alone, before it dissolves); -1 for none.
    pub fuse: i32,
    pub group: u32,
    /// What its group becomes if it survives the fuse; empty to dissolve instead.
    pub reform: String,
    pub pulled: i32,
    /// Metres the current move covers.
    pub stride: f64,
    pub target_x: f64,
    pub target_z: f64,

    // ---- creatures that fight as a pack (crate::pack) ----
    /// The foe it is after (a player, by foe id), or 0.
    pub target: u32,
    /// The war-band it fights with, or 0 on its own.
    pub band: u32,
    /// The pack lets it strike its foe now.
    pub token: bool,
    /// It was let in because the foe left an opening.
    pub opening: bool,
    /// Its courage has run out: it wants to get away, to its friends or home.
    pub afraid: bool,
    /// Where on the ring around its foe it waits.
    pub slot_x: f64,
    pub slot_z: f64,
    /// Where it runs to when afraid.
    pub rally_x: f64,
    pub rally_z: f64,
    /// Where a wander is heading.
    pub dest_x: f64,
    pub dest_z: f64,
    /// Heals it carries.
    pub charges: i32,
    /// Frames before each of its brain's attacks can be used again, in the brain's order.
    pub cds: [i32; ATTACK_SLOTS],
    /// The current state's blow or throw has gone.
    pub struck: bool,
}

/// How many attacks a brain can list, each with its own cooldown (ATTACK_SLOTS in src/sim/actor.ts).
pub const ATTACK_SLOTS: usize = 4;

impl Actor {
    pub fn new(id: u32, kind: &str, x: f64, z: f64, seed: u32) -> Self {
        Self {
            id,
            kind: kind.to_string(),
            faction: FACTION_HOSTILE,
            x,
            y: 0.0,
            z,
            facing: 0.0,
            radius: 0.4,
            hit_height: 0.5,
            hit_ceiling: 1.7,
            solid: false,
            hp: 1.0,
            max_hp: 1.0,
            flash_frame: 999,
            dead_frame: -1,
            brain: None,
            state: 0,
            state_frame: 0,
            wait: 0,
            move_x: 0.0,
            move_z: 1.0,
            home_x: x,
            home_z: z,
            seed,
            lean_x: 0.0,
            lean_z: 0.0,
            lean_vx: 0.0,
            lean_vz: 0.0,
            kind_index: 0,
            respawn_frames: -1,
            mass: 0.0,
            ladder: ladder_of(kind),
            transient: false,
            home_kind: kind.to_string(),
            gone: false,
            angry: 0,
            slam_cd: 0,
            gather_cd: 0,
            rally_to: 0,
            calling: -1,
            taken: 0.0,
            fuse: -1,
            group: 0,
            reform: String::new(),
            pulled: 0,
            stride: 0.0,
            target_x: x,
            target_z: z,
            target: 0,
            band: 0,
            token: false,
            opening: false,
            afraid: false,
            slot_x: x,
            slot_z: z,
            rally_x: x,
            rally_z: z,
            dest_x: x,
            dest_z: z,
            charges: 0,
            cds: [0; ATTACK_SLOTS],
            struck: false,
        }
    }

    /// Builds one from a kind in shared/actors.json, so the server and the browser agree on
    /// what a slime is before either of them draws or hits one.
    pub fn of_kind(id: u32, kind: &ActorKind, index: usize, x: f64, z: f64, seed: u32) -> Self {
        let mut a = Self::new(id, &kind.id, x, z, seed);
        a.faction = kind.faction;
        a.radius = kind.radius;
        a.hit_height = kind.hit_height;
        a.hit_ceiling = kind.hit_ceiling;
        a.solid = kind.solid;
        a.hp = kind.max_hp;
        a.max_hp = kind.max_hp;
        a.brain = kind.brain.clone();
        a.kind_index = index as u8;
        a.respawn_frames = kind.respawn_frames;
        a.mass = kind.mass;
        a
    }

    /// Turns it into another kind where it stands (a slime growing a size). Health is left for
    /// the caller to decide; mass is never shrunk. Mirrors becomeKind() in src/sim/actor.ts.
    pub fn become_kind(&mut self, k: &ActorKind) {
        let brain_changed = self.brain != k.brain;
        self.kind = k.id.clone();
        self.kind_index = kind_index(&k.id).unwrap_or(0) as u8;
        self.faction = k.faction;
        self.radius = k.radius;
        self.hit_height = k.hit_height;
        self.hit_ceiling = k.hit_ceiling;
        self.solid = k.solid;
        self.max_hp = k.max_hp;
        self.hp = self.hp.min(self.max_hp);
        self.brain = k.brain.clone();
        self.ladder = ladder_of(&k.id);
        self.mass = self.mass.max(k.mass);
        if brain_changed {
            self.state = 0;
            self.state_frame = 0;
            self.wait = 0;
        }
    }

    /// Back on its feet where it was spawned, as what it was spawned as.
    pub fn revive(&mut self) {
        if self.kind != self.home_kind
            && let Some(k) = kind(&self.home_kind)
        {
            self.become_kind(k);
        }
        self.mass = kind_mass(&self.home_kind);
        self.hp = self.max_hp;
        self.dead_frame = -1;
        self.flash_frame = 999;
        self.state = 0;
        self.state_frame = 0;
        self.wait = 0;
        self.y = 0.0;
        self.x = self.home_x;
        self.z = self.home_z;
        self.lean_x = 0.0;
        self.lean_z = 0.0;
        self.lean_vx = 0.0;
        self.lean_vz = 0.0;
        self.gone = false;
        self.angry = 0;
        self.slam_cd = 0;
        self.gather_cd = 0;
        self.rally_to = 0;
        self.calling = -1;
        self.taken = 0.0;
        self.fuse = -1;
        self.group = 0;
        self.reform.clear();
        self.pulled = 0;
        self.stride = 0.0;
        self.target = 0;
        self.token = false;
        self.opening = false;
        self.afraid = false;
        self.slot_x = self.x;
        self.rally_x = self.x;
        self.dest_x = self.x;
        self.slot_z = self.z;
        self.rally_z = self.z;
        self.dest_z = self.z;
        self.cds = [0; ATTACK_SLOTS];
        self.struck = false;
    }

    pub fn is_alive(&self) -> bool {
        self.dead_frame < 0
    }
}
