// The training yard's practice: the experience of the skills you use there, kept in this browser
// (the open world keeps it with your island, src/engine/life/progress.ts). Without browser storage (a
// private window, or the headless game in Node) it starts from nothing and isn't kept.
import { BOOK, levelOf } from '../content/skills';
import { trainedBy } from '../engine/island';
import type { GameEvent } from '../engine/rules';

const YARD_XP = 'ruina.skillxp';

export class YardPractice {
  /** Experience by skill id. */
  readonly xp: Record<string, number> = load();
  private saved = 0;

  /** Counts what an event practised, and keeps it when a level is reached (or every few seconds). */
  train(e: GameEvent): void {
    const b = trainedBy(e);
    if (b < 0) return;
    const id = BOOK[b].id;
    const before = levelOf(this.xp[id] ?? 0);
    this.xp[id] = (this.xp[id] ?? 0) + 1;
    if (levelOf(this.xp[id]) > before || performance.now() - this.saved > 3000) {
      this.saved = performance.now();
      try {
        localStorage.setItem(YARD_XP, JSON.stringify(this.xp));
      } catch {
        /* storage unavailable */
      }
    }
  }
}

function load(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(YARD_XP) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
