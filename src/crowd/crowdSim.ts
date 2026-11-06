import { makeRng } from '../rng';
import { TAU } from '../util/math';

// Two armies fighting, simulated the way a game server would: flat typed arrays, a spatial
// grid so each fighter only looks at nearby fighters, and 10 ticks per second.

export const CROWD_TICK = 0.1; // seconds per tick
export const CROWD_SPEED = 5.5; // m/s charge speed
export const ATTACK_TIME = 0.55; // seconds per swing

const REACH = 1.3; // melee range
const SEPARATION = 0.85; // personal space
const DAMAGE = 20;
const HP = 100;
const DEAD_TIME = 2.0; // seconds lying down before respawning at the back
const SPACING = 1.5; // formation spacing (loose, staggered rows)
const FRONT = 30; // each army's front line starts this far from the centre
const FIELD = 140;
const CELL = 2;
const HALF = 160;
const GRID = Math.ceil((HALF * 2) / CELL);

export class CrowdSim {
  readonly n: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly prevX: Float32Array;
  readonly prevZ: Float32Array;
  readonly yaw: Float32Array;
  readonly prevYaw: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  readonly hp: Float32Array;
  readonly attackT: Float32Array; // -1 when not swinging, else 0..1
  readonly swings: Uint16Array; // counts up each time a fighter starts a swing
  readonly team: Uint8Array;
  // Where to draw each fighter this frame (filled by render()).
  readonly rx: Float32Array;
  readonly rz: Float32Array;
  readonly ryaw: Float32Array;
  readonly rspeed: Float32Array;
  readonly down: Uint8Array;
  readonly known: Uint8Array;
  tick = 0;
  tickMs = 0; // average cost of one tick, smoothed
  kills = 0;
  private cooldown: Float32Array;
  private deadT: Float32Array;
  private target: Int32Array;
  private head = new Int32Array(GRID * GRID);
  private next: Int32Array;
  private rng = makeRng(5);
  private cols: number;
  private rows: number;

  constructor(n: number) {
    this.n = n;
    const f = () => new Float32Array(n);
    this.x = f();
    this.z = f();
    this.prevX = f();
    this.prevZ = f();
    this.yaw = f();
    this.prevYaw = f();
    this.vx = f();
    this.vz = f();
    this.hp = f();
    this.attackT = f();
    this.cooldown = f();
    this.deadT = f();
    this.team = new Uint8Array(n);
    this.swings = new Uint16Array(n);
    this.rx = f();
    this.rz = f();
    this.ryaw = f();
    this.rspeed = f();
    this.down = new Uint8Array(n);
    this.known = new Uint8Array(n).fill(1);
    this.target = new Int32Array(n).fill(-1);
    this.next = new Int32Array(n);

    const perTeam = Math.ceil(n / 2);
    this.cols = Math.ceil(Math.sqrt(perTeam * 2)); // formations twice as wide as deep
    this.rows = Math.ceil(perTeam / this.cols);
    for (let i = 0; i < n; i++) {
      const team = i < perTeam ? 0 : 1;
      const j = team === 0 ? i : i - perTeam;
      const col = j % this.cols;
      const row = Math.floor(j / this.cols);
      const side = team === 0 ? -1 : 1;
      this.team[i] = team;
      const stagger = row % 2 ? SPACING / 2 : 0;
      this.x[i] = (col - (this.cols - 1) / 2) * SPACING + stagger + (this.rng() - 0.5) * 0.9;
      this.z[i] = side * (FRONT + row * SPACING + (this.rng() - 0.5) * 0.9);
      this.yaw[i] = team === 0 ? 0 : Math.PI;
      this.hp[i] = HP;
      this.attackT[i] = -1;
      this.cooldown[i] = this.rng();
    }
    this.prevX.set(this.x);
    this.prevZ.set(this.z);
    this.prevYaw.set(this.yaw);
  }

  private cellOf(x: number, z: number): number {
    const cx = Math.max(0, Math.min(GRID - 1, Math.floor((x + HALF) / CELL)));
    const cz = Math.max(0, Math.min(GRID - 1, Math.floor((z + HALF) / CELL)));
    return cz * GRID + cx;
  }

  private buildGrid(): void {
    this.head.fill(-1);
    for (let i = 0; i < this.n; i++) {
      if (this.hp[i] <= 0) continue;
      const c = this.cellOf(this.x[i], this.z[i]);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }

  // Nearest living enemy within a few metres, or -1.
  private findEnemy(i: number): number {
    const { x, z, team, hp } = this;
    const cx = Math.floor((x[i] + HALF) / CELL);
    const cz = Math.floor((z[i] + HALF) / CELL);
    let best = -1;
    let bestD = 36; // 6 m squared
    for (let gz = cz - 3; gz <= cz + 3; gz++) {
      if (gz < 0 || gz >= GRID) continue;
      for (let gx = cx - 3; gx <= cx + 3; gx++) {
        if (gx < 0 || gx >= GRID) continue;
        for (let j = this.head[gz * GRID + gx]; j !== -1; j = this.next[j]) {
          if (team[j] === team[i] || hp[j] <= 0) continue;
          const dx = x[j] - x[i];
          const dz = z[j] - z[i];
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
    }
    return best;
  }

  private respawn(i: number): void {
    const side = this.team[i] === 0 ? -1 : 1;
    const width = this.cols * SPACING;
    this.x[i] = (this.rng() - 0.5) * width;
    this.z[i] = side * (FRONT + this.rows * SPACING + this.rng() * 10);
    this.prevX[i] = this.x[i];
    this.prevZ[i] = this.z[i];
    this.yaw[i] = this.prevYaw[i] = this.team[i] === 0 ? 0 : Math.PI;
    this.vx[i] = this.vz[i] = 0;
    this.hp[i] = HP;
    this.attackT[i] = -1;
    this.target[i] = -1;
  }

  step(): void {
    const t0 = performance.now();
    const dt = CROWD_TICK;
    const { n, x, z, vx, vz, hp, attackT, cooldown, deadT, target, team, yaw } = this;
    this.tick++;
    this.prevX.set(x);
    this.prevZ.set(z);
    this.prevYaw.set(yaw);
    this.buildGrid();

    for (let i = 0; i < n; i++) {
      if (hp[i] <= 0) {
        vx[i] = vz[i] = 0;
        deadT[i] -= dt;
        if (deadT[i] <= 0) this.respawn(i);
        continue;
      }

      // Swinging: the hit lands partway through the swing.
      if (attackT[i] >= 0) {
        const before = attackT[i];
        attackT[i] += dt / ATTACK_TIME;
        const t = target[i];
        if (before < 0.45 && attackT[i] >= 0.45 && t >= 0 && hp[t] > 0) {
          const d = Math.hypot(x[t] - x[i], z[t] - z[i]);
          if (d < REACH + 0.4) {
            hp[t] -= DAMAGE;
            if (hp[t] <= 0) {
              hp[t] = 0;
              deadT[t] = DEAD_TIME;
              attackT[t] = -1;
              this.kills++;
            }
          }
        }
        if (attackT[i] >= 1) attackT[i] = -1;
      }
      if (cooldown[i] > 0) cooldown[i] -= dt;

      // Re-pick a target now and then (staggered so only a fifth of fighters search each tick).
      let t = target[i];
      if (t >= 0 && hp[t] <= 0) t = -1;
      if (t < 0 || (i + this.tick) % 5 === 0) t = this.findEnemy(i);
      target[i] = t;

      let dirX = 0;
      let dirZ = 0;
      let moving = true;
      if (t >= 0) {
        const ex = x[t] - x[i];
        const ez = z[t] - z[i];
        const d = Math.hypot(ex, ez) || 1e-6;
        yaw[i] = Math.atan2(ex, ez);
        if (d > REACH) {
          dirX = ex / d;
          dirZ = ez / d;
        } else {
          moving = false;
          if (attackT[i] < 0 && cooldown[i] <= 0) {
            attackT[i] = 0;
            this.swings[i]++;
            cooldown[i] = 1.1 + this.rng() * 0.6;
          }
        }
      } else {
        // No one in reach: charge toward the enemy side.
        dirZ = team[i] === 0 ? 1 : -1;
        dirX = -x[i] * 0.004;
      }
      if (attackT[i] >= 0) moving = false;

      // Personal space: push away from close neighbours. Also notice a teammate right in
      // front, so the back ranks slow down and step around instead of crushing the front line.
      let sx = 0;
      let sz = 0;
      let seen = 0;
      let blocked = false;
      const cx = Math.floor((x[i] + HALF) / CELL);
      const cz = Math.floor((z[i] + HALF) / CELL);
      for (let gz = cz - 1; gz <= cz + 1 && seen < 10; gz++) {
        if (gz < 0 || gz >= GRID) continue;
        for (let gx = cx - 1; gx <= cx + 1 && seen < 10; gx++) {
          if (gx < 0 || gx >= GRID) continue;
          for (let j = this.head[gz * GRID + gx]; j !== -1 && seen < 10; j = this.next[j]) {
            if (j === i) continue;
            const dx = x[i] - x[j];
            const dz = z[i] - z[j];
            const d2 = dx * dx + dz * dz;
            if (!blocked && t < 0 && team[j] === team[i] && d2 < 1.6 * 1.6 && -(dx * dirX + dz * dirZ) > 0.7 * Math.sqrt(d2)) {
              blocked = true;
            }
            if (d2 >= SEPARATION * SEPARATION || d2 < 1e-8) continue;
            const d = Math.sqrt(d2);
            const push = ((SEPARATION - d) / SEPARATION) * 6;
            sx += (dx / d) * push;
            sz += (dz / d) * push;
            seen++;
          }
        }
      }

      let speed = moving ? CROWD_SPEED : 0;
      if (blocked) {
        // Sidestep (half go left, half go right) to widen the front.
        const s = i % 2 ? 1 : -1;
        sx += -dirZ * s * 2.2;
        sz += dirX * s * 2.2;
        speed *= 0.3;
      }
      vx[i] += (dirX * speed + sx - vx[i]) * 0.6;
      vz[i] += (dirZ * speed + sz - vz[i]) * 0.6;
      if (t < 0 && Math.hypot(vx[i], vz[i]) > 0.5) yaw[i] = Math.atan2(vx[i], vz[i]);
    }

    for (let i = 0; i < n; i++) {
      if (hp[i] <= 0) continue;
      x[i] += vx[i] * dt;
      z[i] += vz[i] * dt;
      const r = Math.hypot(x[i], z[i]);
      if (r > FIELD) {
        x[i] *= FIELD / r;
        z[i] *= FIELD / r;
      }
    }

    const ms = performance.now() - t0;
    this.tickMs = this.tick === 1 ? ms : this.tickMs * 0.9 + ms * 0.1;
  }

  // Blends between the last two ticks (alpha 0..1) into the draw arrays.
  render(alpha: number): void {
    const { x, z, prevX, prevZ, yaw, prevYaw, hp, rx, rz, ryaw, rspeed, down } = this;
    for (let i = 0; i < this.n; i++) {
      const mx = x[i] - prevX[i];
      const mz = z[i] - prevZ[i];
      let dy = (yaw[i] - prevYaw[i]) % TAU;
      if (dy > Math.PI) dy -= TAU;
      if (dy < -Math.PI) dy += TAU;
      rx[i] = prevX[i] + mx * alpha;
      rz[i] = prevZ[i] + mz * alpha;
      ryaw[i] = prevYaw[i] + dy * alpha;
      rspeed[i] = Math.sqrt(mx * mx + mz * mz) / CROWD_TICK;
      down[i] = hp[i] <= 0 ? 1 : 0;
    }
  }

  aliveCount(): number {
    let alive = 0;
    for (let i = 0; i < this.n; i++) if (this.hp[i] > 0) alive++;
    return alive;
  }
}
