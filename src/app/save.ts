import { type IslandView, islandData, type Saved } from '../engine/island';
import type { SimView } from '../engine/rules';

// Your island between visits, in this browser: only for automated tests and bug-report replays
// (?test&load), never for players, whose islands live on the game server (kept in Postgres).
// What an island is and how it's taken up again are the rules' (src/engine/life/save.ts).

/** Where tests and bug-report replays keep an island (bug reports carry a copy, to load the same island). */
export const SAVE_KEY = 'ruina.emberholm.v1';
const KEY = SAVE_KEY;

export function saveData(life: IslandView, sim: SimView): Saved {
  return { savedAt: Date.now(), ...islandData(life, sim) };
}

export function saveLife(life: IslandView, sim: SimView): void {
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

/** The island kept in this browser, or null if there is none (load it with Engine.loadIsland). */
export function savedIsland(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
