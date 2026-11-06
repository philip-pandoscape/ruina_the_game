import type * as THREE from 'three';
import type { CrowdSource } from '../crowd/crowdView';
import type { NetActor, NetCrowd } from '../net/netCrowd';
import { actorKindAt } from '../content/actors';
import type { RemotePlayers } from '../net/netPlayer';
import { isAlive } from '../sim/actor';
import { COMBAT } from '../tuning';
import { WEAPON_NAMES } from '../ui/icons';
import type { Sim } from '../sim/sim';

// Who the game has you aimed at. Pulled out of main.ts because it owns real state of its own -
// the current mark, whether you chose it or the game did - and nothing else needs to see it.

const DEG = Math.PI / 180;

export interface TargetingDeps {
  sim: Sim;
  camera(): THREE.Camera;
  /** Which way the view is facing, for judging what is near the middle of the screen. */
  yaw(): number;
  remotes: RemotePlayers | null;
  crowdSource: CrowdSource | null;
  net: NetCrowd | null;
  playing: boolean;
  /** True when a server is deciding things, which changes who is worth looking at. */
  online: boolean;
  softLock: boolean;
  /** What to call each actor kind on the target plate. */
  names: Record<string, string>;
  /** Online: the server's monsters, where they're drawn on this screen. */
  netActors?: () => readonly NetActor[];
  /** Online: everyone else in the world (players and bots), where they're drawn, with their side. */
  peers?: () => ReadonlyArray<{ id: number; name: string; x: number; y: number; z: number; team: number; hp: number }>;
}

export function createTargeting(d: TargetingDeps) {
  // ---------- Targeting: a soft lock you can override with Tab ----------
  //
  // The game keeps one enemy marked. Normally it picks whoever is nearest the middle of your view
  // (a soft lock, like ESO or TERA) and lets go once they drift well off screen or die. Tab takes
  // that choice away from it: a locked target is kept until it dies, leaves, or you press Escape.
  // Either way the mark feeds the aim for attacks, so the bow and your swings follow it.

  const SOFT_RANGE = 32; // metres: how far away an enemy can be and still be picked up
  const SOFT_CONE = 35 * DEG; // how far off centre it can be to be chosen
  const DROP_CONE = 75 * DEG; // ...and how far it can drift before a soft lock gives up
  const LOCK_RANGE = SOFT_RANGE * 1.5; // a Tab lock holds on further out than it would be picked up
  const softLock = d.softLock;

  interface Mark {
    key: string;
    x: number;
    y: number;
    z: number;
    hp: number; // 0..1
    name: string;
  }

  let targetKey: string | null = null;
  let tabLocked = false;
  const marked: Mark = { key: '', x: 0, y: 0, z: 0, hp: 1, name: '' };
  let haveMark = false;

  // Everything you could be aiming at, cheapest checks first. `visit` is called for each; returning
  // nothing keeps the scan going. Bots are by far the biggest group, so they come last and are
  // rejected on squared distance before anything else is worked out.
  function eachEnemy(range: number, visit: (key: string, x: number, y: number, z: number, hp: number, name: string) => void): void {
    const myTeam = d.sim.player.team;
    const px = d.sim.player.pos.x;
    const pz = d.sim.player.pos.z;
    const r2 = range * range;
    if (!d.online) {
      for (const a of d.sim.actors.all()) {
        if (!isAlive(a) || a.faction === 0 || a.faction === 2) continue; // not you, not townsfolk
        const dx = a.x - px;
        const dz = a.z - pz;
        if (dx * dx + dz * dz > r2) continue;
        visit(`actor:${a.id}`, a.x, a.y, a.z, a.hp / a.maxHp, d.names[a.kind] ?? a.kind);
      }
    }
    if (d.online && d.netActors) {
      for (const a of d.netActors()) {
        const kind = actorKindAt(a.kind);
        if (!kind || a.deadFrame >= 0 || kind.faction === 0 || kind.faction === 2) continue; // not players, not townsfolk
        const dx = a.x - px;
        const dz = a.z - pz;
        if (dx * dx + dz * dz > r2) continue;
        visit(`actor:${a.id}`, a.x, a.y, a.z, a.hp, d.names[kind.id] ?? kind.id);
      }
    }
    // Players and bots on the other side (a developer zone's: on the island everyone is on one).
    for (const p of d.peers?.() ?? []) {
      if (p.team === myTeam || p.hp <= 0) continue;
      const dx = p.x - px;
      const dz = p.z - pz;
      if (dx * dx + dz * dz > r2) continue;
      visit(`w${p.id}`, p.x, p.y, p.z, p.hp / COMBAT.maxHp, p.name);
    }
    for (const r of d.remotes?.list() ?? []) {
      if (r.team === myTeam || r.hp <= 0) continue;
      const dx = r.x - px;
      const dz = r.z - pz;
      if (dx * dx + dz * dz > r2) continue;
      visit(`p${r.id}`, r.x, 0, r.z, r.hp / COMBAT.maxHp, `${WEAPON_NAMES[r.weapon] ?? 'Player'} player`);
    }
    if (d.net) {
      for (let i = 0; i < d.net.n; i++) {
        if (!d.net.known[i] || d.net.down[i] || d.net.team[i] === myTeam) continue;
        const dx = d.net.rx[i] - px;
        const dz = d.net.rz[i] - pz;
        if (dx * dx + dz * dz > r2) continue;
        visit(`b${i}`, d.net.rx[i], 0, d.net.rz[i], d.net.hp[i] / 255, 'Fighter');
      }
    }
  }

  // How far off the middle of the view something is, in radians.
  function offCentre(x: number, z: number): number {
    let off = Math.abs(Math.atan2(x - d.sim.player.pos.x, z - d.sim.player.pos.z) - d.yaw()) % (Math.PI * 2);
    if (off > Math.PI) off = Math.PI * 2 - off;
    return off;
  }

  // Picks the mark for this frame: keep the one you have while it's still good, otherwise (unless
  // you locked it with Tab) take whoever is nearest the middle of the view.
  function updateTarget(): void {
    if (d.net && !d.playing) {
      haveMark = false;
      targetKey = null;
      return;
    }
    const keepRange = tabLocked ? LOCK_RANGE : SOFT_RANGE;
    let kept = false;
    let best = '';
    let bestScore = Infinity;
    let bx = 0;
    let by = 0;
    let bz = 0;
    let bhp = 1;
    let bname = '';
    eachEnemy(keepRange, (key, x, y, z, hp, name) => {
      if (key === targetKey) {
        const off = offCentre(x, z);
        // A lock ignores where you're looking; a soft lock lets go once it's well off to the side.
        if (tabLocked || off <= DROP_CONE) {
          kept = true;
          marked.key = key;
          marked.x = x;
          marked.y = y;
          marked.z = z;
          marked.hp = hp;
          marked.name = name;
        }
      }
      if (kept || !softLock || tabLocked) return;
      const dx = x - d.sim.player.pos.x;
      const dz = z - d.sim.player.pos.z;
      const dist = Math.hypot(dx, dz);
      const off = offCentre(x, z);
      if (dist > SOFT_RANGE || off > SOFT_CONE) return;
      const score = dist / SOFT_RANGE + off / SOFT_CONE;
      if (score < bestScore) {
        bestScore = score;
        best = key;
        bx = x;
        by = y;
        bz = z;
        bhp = hp;
        bname = name;
      }
    });
    if (kept) {
      haveMark = true;
      return;
    }
    // Whatever we had is gone, out of range, or looked away from.
    tabLocked = false;
    if (!best) {
      haveMark = false;
      targetKey = null;
      return;
    }
    targetKey = best;
    haveMark = true;
    marked.key = best;
    marked.x = bx;
    marked.y = by;
    marked.z = bz;
    marked.hp = bhp;
    marked.name = bname;
  }

  // Tab: step to the next enemy, nearest first. Shift-Tab goes back. The order is rebuilt from the
  // current positions on each press, so it stays stable for as long as nobody moves past anyone.
  function cycleTarget(step: number): void {
    if (d.net && !d.playing) return;
    const list: Array<{ key: string; d: number }> = [];
    eachEnemy(SOFT_RANGE, (key, x, _y, z) => {
      list.push({ key, d: Math.hypot(x - d.sim.player.pos.x, z - d.sim.player.pos.z) });
    });
    if (!list.length) return;
    list.sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : 1));
    const at = list.findIndex((c) => c.key === targetKey);
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
    targetKey = list[next].key;
    tabLocked = true;
  }
  return {
    update: updateTarget,
    cycle: cycleTarget,
    /** Forgets the current pick, so the soft lock starts again from scratch. */
    clear(): void {
      tabLocked = false;
      targetKey = null;
    },
    /** The current mark, or null when nothing is picked out. */
    mark: (): Mark | null => (haveMark ? marked : null),
    get locked() {
      return tabLocked;
    },
  };
}
