import { CLOCK } from '../../content/trade';
import type { Sim } from '../sim';
import { groundAt } from '../zone/colliders';
import { addScarecrowCollider, growFor } from './farming';
import { addHouseColliders } from './housing';
import { shortTime } from './interact';
import type { Life } from './life';
import { LIFE_VERSION, type LifeState } from './state';
import { recoverDemand } from './trade';
import { exitSpot, ridden } from './vehicles';

// Your island as the rules keep it between visits: money, bag, farms, house, vehicles, quests, and
// where you were standing, and how it's taken up again with the time you were away (crops ripen,
// labor refills, demand recovers). The server keeps players' islands (crates/server/src/play/mod.rs
// load_island is this one's twin); this browser keeps one only for automated tests and bug-report
// replays (src/app/save.ts).

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

/**
 * Restores a saved island into a fresh Life and Sim. `now` is the clock `savedAt` was measured
 * on (the server's, online), for the time you were away. Returns false, changing nothing, for a
 * save from a newer game than this one.
 */
export function applySave(life: Life, sim: Sim, data: Saved, now: number): boolean {
  // Older saves are migrated forward; only a save from a newer game than this one is refused.
  if (!data?.state || (data.state.version ?? 0) > LIFE_VERSION) return false;
  data.state.version = LIFE_VERSION;
  life.load(data.state);
  const s = life.state;
  for (const v of s.vehicles) v.ridden = false;
  // A stake still on a table when this was saved: no game holds it now (games live only on the
  // server, while they're played), so it's back in the purse, as the server does (load_island).
  if (s.staked) s.coins += s.staked;
  delete s.staked;
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
