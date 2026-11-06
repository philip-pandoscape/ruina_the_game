// The engine's game (crates/engine/src/session.rs) through its WebAssembly (crates/engine-wasm,
// src/session.rs): the rules for one player in the island or the yard, as the Engine runs the
// TypeScript rules today, stepped once per fixed frame and read back in the TypeScript's shapes. The
// Engine runs one beside its TypeScript rules when shadowing (src/engine/shadow.ts), and in time in
// their place (the refactor's Phase 8).

import type { Levels } from '../content/skills';
import type { Build } from '../content/tuning';
import type { Actor, Missile } from './actors/actor';
import type { Focus, Placement } from './life/interact';
import type { LifeEvent } from './life/life';
import type { LifeState } from './life/state';
import type { ArrowFlight, MeteorFall } from './training';
import type { Actions, GameEvent, Obstacle, PlayerState } from './shapes';
import type { BoxCollider, Deck } from './world/types';
import { answer, wasm, withText } from './wasm';

export interface SessionOptions {
  openWorld: boolean;
  online: boolean;
  goblins?: number;
  build: Build;
}

/** The island as the session shows it. */
export interface SessionLife {
  state: LifeState;
  focus: Focus | null;
  placing: Placement | null;
  resting: boolean;
  revision: number;
}

/** Everything the page reads after a step or a call (crates/engine/src/session.rs view_json). */
export interface SessionView {
  frame: number;
  hitstop: number;
  player: PlayerState;
  /** Your skill levels, which the island raises as you earn them. */
  levels: Levels;
  actors: { list: Actor[]; missiles: Missile[]; arrows: ArrowFlight[]; meteors: MeteorFall[] };
  life: SessionLife | null;
  /** What the island said (toasts, windows to open), taken. */
  said: LifeEvent[];
  /** Offline, fallen out of the bottom of a copy this step: put back where it's entered, facing this way. */
  placed: number | null;
  /** Changes whenever what's solid does. */
  solid: number;
  /** After a step, what happened in it (taken); after a call, nothing (it comes out with the next step). */
  events: GameEvent[];
}

export class EngineSession {
  private readonly h: number;

  constructor(o: SessionOptions) {
    const e = wasm();
    this.h = withText(JSON.stringify(o), (p, n) => e.session_new(p, n));
    if (!this.h) throw new Error('the engine could not start a session from these options');
  }

  /** One fixed step with what was pressed. */
  step(a: Actions): void {
    const flags =
      (a.jumpPressed ? 1 : 0) | (a.jumpHeld ? 2 : 0) | (a.attackPressed ? 4 : 0) | (a.slidePressed ? 8 : 0) | (a.sprintHeld ? 16 : 0) | (a.crouchHeld ? 32 : 0);
    wasm().session_step(this.h, a.moveX, a.moveZ, flags, a.abilitySlot, a.movementSlot, a.movementHeld, a.aimX, a.aimZ, a.faceX, a.faceZ, a.stickX, a.stickY);
  }

  /** What happened since the last time, in order. */
  events(): GameEvent[] {
    return answer<GameEvent[]>(wasm().session_events(this.h));
  }

  /** You, as the session has you. */
  player(): PlayerState {
    return answer<PlayerState>(wasm().session_player(this.h));
  }

  /** The creatures, and what they've thrown. */
  actors(): { list: Actor[]; missiles: Missile[] } {
    return answer(wasm().session_actors(this.h));
  }

  /** The island (null in the yard). */
  life(): SessionLife | null {
    return answer<SessionLife | null>(wasm().session_life(this.h));
  }

  /** Online, the world's clock (seconds since 1970) the rain and the wind run on, for the next step; null for the island's own. */
  worldClock(t: number | null): void {
    wasm().session_world_clock(this.h, t ?? Number.NaN);
  }

  /** Online, your island as a tick has it (its state as it came, whether you're placing something or resting). */
  takeIsland(island: { state: LifeState; placing: unknown; resting: boolean }): void {
    const e = wasm();
    if (!withText(JSON.stringify(island), (p, n) => e.session_take_island(this.h, p, n))) throw new Error('engine session: the island could not be read');
  }

  /** Everything the page reads, after a step (`events`: with what happened in it, taken) or a call. */
  view(events: boolean): SessionView {
    return answer<SessionView>(wasm().session_view(this.h, events ? 1 : 0));
  }

  /** Everything solid on the island as it stands (null on the yard's flat ground). */
  colliders(): { obstacles: Obstacle[]; boxes: BoxCollider[]; decks: Deck[] } | null {
    return answer(wasm().session_colliders(this.h));
  }

  /** The island's cells kept clear of trees and scarecrows, copied into `into` (as long as the island's). */
  clear(into: Uint8Array): void {
    const e = wasm();
    const n = e.session_clear_len(this.h);
    if (n !== into.length) return;
    into.set(new Uint8Array(e.memory.buffer, e.session_clear_ptr(this.h), n));
  }

  /** One of the Engine's other calls, by its name, with its arguments. */
  call<T = null>(name: string, args: object = {}): T {
    const e = wasm();
    const out = withText(JSON.stringify({ call: name, ...args }), (p, n) => answer<T | { error: string }>(e.session_call(this.h, p, n)));
    if (out && typeof out === 'object' && 'error' in out && Object.keys(out).length === 1) throw new Error(`engine session: ${out.error}`);
    return out as T;
  }

  free(): void {
    wasm().session_free(this.h);
  }
}
