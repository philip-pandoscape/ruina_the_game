//! Two armies of bots fighting: the same rules as the browser's crowdSim.ts, ported to Rust.
//! Data is kept as one array per field, and a spatial grid means each bot only looks at nearby bots.

pub const SPEED: f32 = 5.5; // m/s charge speed
pub const ATTACK_TIME: f32 = 0.55; // seconds per swing
pub const MAX_HP: f32 = 100.0;
pub const FIELD: f32 = 140.0; // bots stay inside this radius

const REACH: f32 = 1.3;
const SEPARATION: f32 = 0.85;
const DAMAGE: f32 = 20.0;
const DAMAGE_ON_PLAYERS: f32 = 8.0; // bots hit real players a bit softer (100 hp, about 12 hits)
const DEAD_TIME: f32 = 2.0;
const SPACING: f32 = 1.5;
const FRONT: f32 = 30.0;
const CELL: f32 = 2.0;
const HALF: f32 = 160.0;
const GRID: i32 = 160; // (HALF * 2 / CELL)

// mulberry32, same as src/rng.ts
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }

    // Same value as rng() in TypeScript, at full precision.
    pub fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }

    pub fn next(&mut self) -> f32 {
        self.next_f64() as f32
    }
}

/// A real player the bots can fight: which player slot, where, and which side.
pub struct BotTarget {
    pub slot: u32,
    pub x: f32,
    pub z: f32,
    pub team: u8,
}

/// A bot's hit on a real player, for the player code to apply.
pub struct BotHit {
    pub slot: u32,
    pub damage: f32,
    pub dir_x: f32,
    pub dir_z: f32,
}

pub struct Battle {
    pub n: usize,
    pub tick: u64,
    pub kills: u64,
    pub x: Vec<f32>,
    pub z: Vec<f32>,
    pub yaw: Vec<f32>,
    pub hp: Vec<f32>,
    pub attack_t: Vec<f32>, // -1 when not swinging, else 0..1
    pub swings: Vec<u8>,    // counts up (and wraps) each time a bot starts a swing
    pub team: Vec<u8>,
    vx: Vec<f32>,
    vz: Vec<f32>,
    cooldown: Vec<f32>,
    dead_t: Vec<f32>,
    target: Vec<i32>,
    head: Vec<i32>,
    next: Vec<i32>,
    rng: Rng,
    cols: usize,
    rows: usize,
}

fn cell_coord(v: f32) -> i32 {
    (((v + HALF) / CELL).floor() as i32).clamp(0, GRID - 1)
}

impl Battle {
    pub fn new(n: usize) -> Self {
        let per_team = n.div_ceil(2);
        let cols = ((per_team * 2) as f32).sqrt().ceil() as usize; // twice as wide as deep
        let rows = per_team.div_ceil(cols);
        let mut b = Battle {
            n,
            tick: 0,
            kills: 0,
            x: vec![0.0; n],
            z: vec![0.0; n],
            yaw: vec![0.0; n],
            hp: vec![MAX_HP; n],
            attack_t: vec![-1.0; n],
            swings: vec![0; n],
            team: vec![0; n],
            vx: vec![0.0; n],
            vz: vec![0.0; n],
            cooldown: vec![0.0; n],
            dead_t: vec![0.0; n],
            target: vec![-1; n],
            head: vec![-1; (GRID * GRID) as usize],
            next: vec![-1; n],
            rng: Rng::new(5),
            cols,
            rows,
        };
        for i in 0..n {
            let team = if i < per_team { 0 } else { 1 };
            let j = if team == 0 { i } else { i - per_team };
            let (col, row) = (j % cols, j / cols);
            let side = if team == 0 { -1.0 } else { 1.0 };
            let stagger = if row % 2 == 1 { SPACING / 2.0 } else { 0.0 };
            b.team[i] = team;
            b.x[i] = (col as f32 - (cols as f32 - 1.0) / 2.0) * SPACING + stagger + (b.rng.next() - 0.5) * 0.9;
            b.z[i] = side * (FRONT + row as f32 * SPACING + (b.rng.next() - 0.5) * 0.9);
            b.yaw[i] = if team == 0 { 0.0 } else { std::f32::consts::PI };
            b.cooldown[i] = b.rng.next();
        }
        b
    }

    fn build_grid(&mut self) {
        self.head.fill(-1);
        for i in 0..self.n {
            if self.hp[i] <= 0.0 {
                continue;
            }
            let c = (cell_coord(self.z[i]) * GRID + cell_coord(self.x[i])) as usize;
            self.next[i] = self.head[c];
            self.head[c] = i as i32;
        }
    }

    // Nearest living enemy within 6 m, or -1.
    fn find_enemy(&self, i: usize, players: &[BotTarget]) -> i32 {
        let (cx, cz) = (cell_coord(self.x[i]), cell_coord(self.z[i]));
        let mut best = -1;
        let mut best_d = 36.0;
        for gz in (cz - 3).max(0)..=(cz + 3).min(GRID - 1) {
            for gx in (cx - 3).max(0)..=(cx + 3).min(GRID - 1) {
                let mut j = self.head[(gz * GRID + gx) as usize];
                while j != -1 {
                    let ju = j as usize;
                    if self.team[ju] != self.team[i] && self.hp[ju] > 0.0 {
                        let (dx, dz) = (self.x[ju] - self.x[i], self.z[ju] - self.z[i]);
                        let d = dx * dx + dz * dz;
                        if d < best_d {
                            best_d = d;
                            best = j;
                        }
                    }
                    j = self.next[ju];
                }
            }
        }
        // Real players count as enemies too.
        for p in players {
            if p.team == self.team[i] {
                continue;
            }
            let (dx, dz) = (p.x - self.x[i], p.z - self.z[i]);
            let d = dx * dx + dz * dz;
            if d < best_d {
                best_d = d;
                best = (self.n + p.slot as usize) as i32;
            }
        }
        best
    }

    fn respawn(&mut self, i: usize) {
        let side = if self.team[i] == 0 { -1.0 } else { 1.0 };
        let width = self.cols as f32 * SPACING;
        self.x[i] = (self.rng.next() - 0.5) * width;
        self.z[i] = side * (FRONT + self.rows as f32 * SPACING + self.rng.next() * 10.0);
        self.yaw[i] = if self.team[i] == 0 { 0.0 } else { std::f32::consts::PI };
        self.vx[i] = 0.0;
        self.vz[i] = 0.0;
        self.hp[i] = MAX_HP;
        self.attack_t[i] = -1.0;
        self.target[i] = -1;
    }

    /// Living bots within `r` of (x, z), using the grid from the last step.
    pub fn bots_near(&self, x: f32, z: f32, r: f32, out: &mut Vec<usize>) {
        out.clear();
        let span = (r / CELL).ceil() as i32;
        let (cx, cz) = (cell_coord(x), cell_coord(z));
        for gz in (cz - span).max(0)..=(cz + span).min(GRID - 1) {
            for gx in (cx - span).max(0)..=(cx + span).min(GRID - 1) {
                let mut j = self.head[(gz * GRID + gx) as usize];
                while j != -1 {
                    let ju = j as usize;
                    j = self.next[ju];
                    let (dx, dz) = (self.x[ju] - x, self.z[ju] - z);
                    if self.hp[ju] > 0.0 && dx * dx + dz * dz <= r * r {
                        out.push(ju);
                    }
                }
            }
        }
    }

    /// Healing Circle on bots: heals living bots of `team` within `r` of (x, z).
    pub fn heal_bots(&mut self, x: f32, z: f32, r: f32, team: u8, amount: f32) {
        let mut near = Vec::new();
        self.bots_near(x, z, r, &mut near);
        for i in near {
            if self.team[i] == team {
                self.hp[i] = (self.hp[i] + amount).min(MAX_HP);
            }
        }
    }

    /// A player's hit on a bot.
    pub fn damage_bot(&mut self, i: usize, damage: f32) {
        if self.hp[i] <= 0.0 {
            return;
        }
        self.hp[i] -= damage;
        if self.hp[i] <= 0.0 {
            self.hp[i] = 0.0;
            self.dead_t[i] = DEAD_TIME;
            self.attack_t[i] = -1.0;
            self.kills += 1;
        }
    }

    pub fn alive(&self) -> usize {
        self.hp.iter().filter(|&&h| h > 0.0).count()
    }

    // Where target `t` stands: a bot (t < n) or a player (t = n + slot). None if it's gone or down.
    fn target_pos(&self, t: i32, players: &[BotTarget], lookup: &[i32]) -> Option<(f32, f32)> {
        if t < 0 {
            return None;
        }
        let t = t as usize;
        if t < self.n {
            return (self.hp[t] > 0.0).then(|| (self.x[t], self.z[t]));
        }
        let k = *lookup.get(t - self.n)?;
        (k >= 0).then(|| (players[k as usize].x, players[k as usize].z))
    }

    /// One tick of the battle. Bots can also target real players (`players`); hits on them are
    /// written to `hits` for the player code to apply.
    pub fn step(&mut self, dt: f32, players: &[BotTarget], hits: &mut Vec<BotHit>) {
        self.tick += 1;
        self.build_grid();
        let mut lookup = vec![-1i32; players.iter().map(|p| p.slot as usize + 1).max().unwrap_or(0)];
        for (k, p) in players.iter().enumerate() {
            lookup[p.slot as usize] = k as i32;
        }

        for i in 0..self.n {
            if self.hp[i] <= 0.0 {
                self.vx[i] = 0.0;
                self.vz[i] = 0.0;
                self.dead_t[i] -= dt;
                if self.dead_t[i] <= 0.0 {
                    self.respawn(i);
                }
                continue;
            }

            // Swinging: the hit lands partway through the swing.
            if self.attack_t[i] >= 0.0 {
                let before = self.attack_t[i];
                self.attack_t[i] += dt / ATTACK_TIME;
                let t = self.target[i];
                if before < 0.45 && self.attack_t[i] >= 0.45 {
                    if let Some((tx, tz)) = self.target_pos(t, players, &lookup) {
                        let (ddx, ddz) = (tx - self.x[i], tz - self.z[i]);
                        let d = (ddx * ddx + ddz * ddz).sqrt();
                        if d < REACH + 0.4 {
                            let tu = t as usize;
                            if tu < self.n {
                                self.hp[tu] -= DAMAGE;
                                if self.hp[tu] <= 0.0 {
                                    self.hp[tu] = 0.0;
                                    self.dead_t[tu] = DEAD_TIME;
                                    self.attack_t[tu] = -1.0;
                                    self.kills += 1;
                                }
                            } else {
                                let dd = d.max(1e-6);
                                hits.push(BotHit { slot: (tu - self.n) as u32, damage: DAMAGE_ON_PLAYERS, dir_x: ddx / dd, dir_z: ddz / dd });
                            }
                        }
                    }
                }
                if self.attack_t[i] >= 1.0 {
                    self.attack_t[i] = -1.0;
                }
            }
            if self.cooldown[i] > 0.0 {
                self.cooldown[i] -= dt;
            }

            // Look for a target on a staggered schedule (idle bots 5 times a second, engaged bots
            // 4 times a second), or right away when the current target falls.
            let mut t = self.target[i];
            let target_fell = t >= 0 && self.target_pos(t, players, &lookup).is_none();
            if target_fell {
                t = -1;
            }
            let turn = i as u64 + self.tick;
            if target_fell || (t < 0 && turn % 4 == 0) || (t >= 0 && turn % 5 == 0) {
                t = self.find_enemy(i, players);
            }
            self.target[i] = t;

            let (mut dir_x, mut dir_z, mut moving) = (0.0f32, 0.0f32, true);
            if let Some((tx, tz)) = self.target_pos(t, players, &lookup) {
                let (ex, ez) = (tx - self.x[i], tz - self.z[i]);
                let d = (ex * ex + ez * ez).sqrt().max(1e-6);
                self.yaw[i] = ex.atan2(ez);
                if d > REACH {
                    dir_x = ex / d;
                    dir_z = ez / d;
                } else {
                    moving = false;
                    if self.attack_t[i] < 0.0 && self.cooldown[i] <= 0.0 {
                        self.attack_t[i] = 0.0;
                        self.swings[i] = self.swings[i].wrapping_add(1);
                        self.cooldown[i] = 1.1 + self.rng.next() * 0.6;
                    }
                }
            } else {
                // No one in reach: charge toward the enemy side.
                dir_z = if self.team[i] == 0 { 1.0 } else { -1.0 };
                dir_x = -self.x[i] * 0.004;
            }
            if self.attack_t[i] >= 0.0 {
                moving = false;
            }

            // Personal space, and noticing a teammate right in front (back ranks step around).
            let (mut sx, mut sz, mut seen, mut blocked) = (0.0f32, 0.0f32, 0, false);
            let (cx, cz) = (cell_coord(self.x[i]), cell_coord(self.z[i]));
            'outer: for gz in (cz - 1).max(0)..=(cz + 1).min(GRID - 1) {
                for gx in (cx - 1).max(0)..=(cx + 1).min(GRID - 1) {
                    let mut j = self.head[(gz * GRID + gx) as usize];
                    while j != -1 {
                        let ju = j as usize;
                        j = self.next[ju];
                        if ju == i {
                            continue;
                        }
                        let (dx, dz) = (self.x[i] - self.x[ju], self.z[i] - self.z[ju]);
                        let d2 = dx * dx + dz * dz;
                        if !blocked && t < 0 && self.team[ju] == self.team[i] && d2 < 1.6 * 1.6 && -(dx * dir_x + dz * dir_z) > 0.7 * d2.sqrt() {
                            blocked = true;
                        }
                        if d2 >= SEPARATION * SEPARATION || d2 < 1e-8 {
                            continue;
                        }
                        let d = d2.sqrt();
                        let push = (SEPARATION - d) / SEPARATION * 6.0;
                        sx += dx / d * push;
                        sz += dz / d * push;
                        seen += 1;
                        if seen >= 10 {
                            break 'outer;
                        }
                    }
                }
            }

            let mut speed = if moving { SPEED } else { 0.0 };
            if blocked {
                let s = if i % 2 == 1 { 1.0 } else { -1.0 };
                sx += -dir_z * s * 2.2;
                sz += dir_x * s * 2.2;
                speed *= 0.3;
            }
            self.vx[i] += (dir_x * speed + sx - self.vx[i]) * 0.6;
            self.vz[i] += (dir_z * speed + sz - self.vz[i]) * 0.6;
            if t < 0 && self.vx[i] * self.vx[i] + self.vz[i] * self.vz[i] > 0.25 {
                self.yaw[i] = self.vx[i].atan2(self.vz[i]);
            }
        }

        for i in 0..self.n {
            if self.hp[i] <= 0.0 {
                continue;
            }
            self.x[i] += self.vx[i] * dt;
            self.z[i] += self.vz[i] * dt;
            let r = (self.x[i] * self.x[i] + self.z[i] * self.z[i]).sqrt();
            if r > FIELD {
                self.x[i] *= FIELD / r;
                self.z[i] *= FIELD / r;
            }
        }
    }
}
