// What the page reads of the rules (.plans/refactor R8.7-R8.9), as the engine's session last showed
// it: you, the step count and the hit pause, your skills' numbers, the creatures and the yard's
// arrows and meteors in flight. The Engine (src/engine/engine.ts) fills these in after every step and
// every call; nothing else writes them, and the rules never read them back. Read them afresh: what a
// step hands over is new each time, so a part kept from an earlier step is that step's.

import { BOOK, type Levels, type ResolvedSkills, resolveSkills } from '../content/skills';
import type { Actor, Missile } from '../sim/actor';
import type { ArrowFlight, MeteorFall } from '../sim/training';
import type { GameEvent, PlayerState, World } from '../sim/types';

/** The creatures as the engine last showed them (offline: online the server's are drawn from its updates). */
export class ActorsView {
  list: Actor[] = [];
  missiles: Missile[] = [];

  all(): readonly Actor[] {
    return this.list;
  }

  get(id: number): Actor | undefined {
    return this.list.find((a) => a.id === id);
  }
}

/** Offline, the yard's arrows and meteors in flight, for drawing. */
export class RangeView {
  arrows: ArrowFlight[] = [];
  meteors: MeteorFall[] = [];
}

/** How many of what happened are kept for the tests to read (the newest). */
const LOG = 500;

/** You and what's about you, as the engine last showed them. */
export class SimView {
  /** Fixed steps taken so far: the clock everything is drawn by. */
  frame = 0;
  /** Offline, frames left of a hit's pause. */
  hitstop = 0;
  /** The level of each skill in the skill book (src/content/skills.ts BOOK), which adds to what it does. */
  levels: Levels = BOOK.map(() => 1);
  /** What happened lately, newest last (the tests read it). */
  readonly log: GameEvent[] = [];
  readonly actors = new ActorsView();
  private resolvedFor = '';
  private resolved: ResolvedSkills | null = null;

  constructor(
    readonly world: World,
    public player: PlayerState,
  ) {}

  /** What your build's skills make of your attacks and spells (reach, radius, damage), at your levels. */
  get stats(): ResolvedSkills {
    const key = `${this.player.skills.join(',')}|${this.levels.join(',')}`;
    if (!this.resolved || key !== this.resolvedFor) {
      this.resolvedFor = key;
      this.resolved = resolveSkills(this.player.skills, this.levels);
    }
    return this.resolved;
  }

  /** The first creature of a kind, for the few callers that want a specific one by name. */
  actorOfKind(kind: string): Actor | undefined {
    return this.actors.list.find((a) => a.kind === kind);
  }

  /** Adds what a step showed to the log. */
  heard(events: readonly GameEvent[]): void {
    this.log.push(...events);
    if (this.log.length > LOG) this.log.splice(0, this.log.length - LOG);
  }
}
