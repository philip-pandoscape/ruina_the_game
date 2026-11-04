//! Everything in the world that is not a player: monsters, NPCs, props. Mirrors src/sim/actor.ts
//! field for field, because the browser runs the same rules offline in the training yard and the
//! two have to agree.

pub const FACTION_PLAYER: u8 = 0;
pub const FACTION_HOSTILE: u8 = 1;
pub const FACTION_NEUTRAL: u8 = 2;
pub const FACTION_PROP: u8 = 3;

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
    pub respawn_frames: i32,
}

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
        }
    }

    /// Builds one from a kind in shared/actors.json, so the server and the browser agree on
    /// what a slime is before either of them draws or hits one.
    pub fn of_kind(id: u32, kind: &crate::content::ActorKind, index: usize, x: f64, z: f64, seed: u32) -> Self {
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
        a
    }

    pub fn revive(&mut self) {
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
    }

    pub fn is_alive(&self) -> bool {
        self.dead_frame < 0
    }
}
