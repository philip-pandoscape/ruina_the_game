// The island as the page reads it (.plans/refactor R8.7): what the engine's session says it holds,
// read back after each step and each call that changes it, with the few things the page asks of it
// (how many of an item you have, what happened, sending a command). The rules that change it run in
// the engine (crates/engine/src/life), offline in this page's session and online on the server, so
// nothing here changes the island: a command goes to whoever runs it.

import type { Focus, Placement } from '../sim/life/interact';
import type { Command, LifeEvent } from '../sim/life/life';
import type { LifeState } from '../sim/life/state';
import type { ZoneData } from '../sim/zone/world';

/** How many things the island has said that are kept for the page to show (the oldest go first). */
const KEPT = 200;

export class IslandView {
  /** The island's state as last read: replaced whole each time, so read it afresh rather than keep parts of it. */
  state: LifeState;
  /** What F does here (the prompt on screen). */
  focus: Focus | null = null;
  /** A scarecrow being walked to its spot, if one is. */
  placing: Placement | null = null;
  /** True for the moment you are resting in your own bed. */
  resting = false;
  /** Bumped whenever something drawn from the state (farms, houses, packs) changes shape. */
  revision = 0;
  /** The dungeon or developer zone you're inside a copy of (null out on the island). */
  dungeon: string | null = null;
  private events: LifeEvent[] = [];

  constructor(
    readonly zone: ZoneData,
    state: LifeState,
    private readonly send: (c: Command) => void,
  ) {
    this.state = state;
  }

  /** How many of an item are in your bag. */
  count(item: string): number {
    let n = 0;
    for (const s of this.state.bag) if (s.item === item) n += s.n;
    return n;
  }

  /** A command for the island: run by the engine on its next step offline, sent to the server online. */
  command(c: Command): void {
    this.send(c);
  }

  /** What the island has said since the last time (toasts, windows to open, what was sold...). */
  drainEvents(): LifeEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Something the island said: the engine's offline, the server's online. */
  hear(e: LifeEvent): void {
    this.events.push(e);
    if (this.events.length > KEPT) this.events.shift();
  }

  /** Something the server's island said (a toast, a window to open), to show here. */
  fromServer(e: LifeEvent): void {
    this.hear(e);
  }
}
