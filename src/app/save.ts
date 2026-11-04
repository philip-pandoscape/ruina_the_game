import type { Life } from '../sim/life/life';
import type { Sim } from '../sim/sim';
import { LIFE_VERSION, type LifeState } from '../sim/life/state';
import { CLOCK } from '../content/trade';
import { growFor, addScarecrowCollider } from '../sim/life/farming';
import { recoverDemand } from '../sim/life/trade';
import { addHouseColliders } from '../sim/life/housing';
import { groundAt } from '../sim/zone/colliders';
import { shortTime } from '../sim/life/interact';
import { exitSpot, ridden } from '../sim/life/vehicles';

// Your island between visits: money, bag, farms, house, vehicles, quests, and where you were
// standing. Players' islands live on the game server (src/net/worldLink.ts, kept in Postgres).
// The world clock keeps running while you are away (up to a cap), so crops ripen and labor refills
// while you're gone.
//
// This browser's localStorage holds an island only for automated tests and bug-report replays
// (?world&test&load), never for players.

/** Where tests and bug-report replays keep an island (bug reports carry a copy, to load the same island). */
export const SAVE_KEY = 'ruina.emberholm.v1';
const KEY = SAVE_KEY;

/** The island as the server keeps it. */
export interface Island {
  state: LifeState;
  player: { x: number; y: number; z: number; facing: number };
}

/** An island and when it was saved (ms, on whichever clock `now` is measured on when it loads). */
export interface Saved extends Island {
  savedAt: number;
}

/** The island as it would be saved right now. */
export function islandData(life: Life, sim: Sim): Island {
  const p = sim.player;
  // Riding is not saved: you will be standing beside it next time.
  const v = p.mode === 'ride' ? ridden(life, sim) : undefined;
  const at = v ? exitSpot(sim, v) : p.pos;
  return { state: life.state, player: { x: at.x, y: at.y, z: at.z, facing: p.facing } };
}

export function saveData(life: Life, sim: Sim): Saved {
  return { savedAt: Date.now(), ...islandData(life, sim) };
}

/**
 * Restores a saved island into a fresh Life and Sim. `now` is the clock `savedAt` was measured
 * on (the server's, online), for the time you were away. Returns false, changing nothing, for a
 * save from a newer game than this one.
 */
export function applySave(life: Life, sim: Sim, data: Saved, now = Date.now()): boolean {
  // Older saves are migrated forward; only a save from a newer game than this one is refused.
  if (!data?.state || (data.state.version ?? 0) > LIFE_VERSION) return false;
  data.state.version = LIFE_VERSION;
  life.load(data.state);
  const s = life.state;
  for (const v of s.vehicles) v.ridden = false;
  for (const sc of s.scarecrows) addScarecrowCollider(sim, sc);
  for (const h of s.houses) addHouseColliders(life, sim, h);

  // Time away.
  const away = Math.max(0, Math.min(CLOCK.maxOfflineSeconds, (now - data.savedAt) / 1000)) * CLOCK.offlineFactor;
  if (away > 1) {
    s.clock += away;
    growFor(life, away);
    recoverDemand(life, away);
    life.regenLabor(away, false, true);
    if (away > 60) life.toast(`Welcome back - ${shortTime(away)} passed on Emberholm while you were away`, 'info');
  }

  // Where you were.
  const p = sim.player;
  const hf = sim.world.terrain!;
  const { x, z, facing } = data.player;
  if (hf.inside(x, z, 10)) {
    const y = groundAt(hf, sim.world.index, x, z, Math.max(data.player.y, hf.height(x, z)) + 0.5, 1);
    p.pos = { x, y, z };
    p.prevPos = { x, y, z };
    p.facing = facing;
    p.prevFacing = facing;
    p.grounded = true;
  }
  life.afterReset(sim);
  return true;
}

// ---------- In this browser: automated tests and bug-report replays only ----------

export function saveLife(life: Life, sim: Sim): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saveData(life, sim)));
  } catch {
    /* storage full or blocked: carry on unsaved */
  }
}

export function clearLife(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Restores the island kept in this browser. Returns false (and changes nothing) if there is none. */
export function loadLife(life: Life, sim: Sim): boolean {
  let data: Saved;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    data = JSON.parse(raw) as Saved;
  } catch {
    return false;
  }
  return applySave(life, sim, data);
}
