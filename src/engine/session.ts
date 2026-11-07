// The engine's game (crates/engine/src/session.rs) through its WebAssembly (crates/engine-wasm,
// src/session.rs): the rules for one player in the world or a copy of an instance, stepped once per
// fixed frame and read back after each step or call in the shapes the page reads (`view`, one JSON
// text written straight from the session's values).

import type { Levels } from '../content/skills';
import type { Build } from '../content/tuning';
import type { Actor, Missile } from './actors/actor';
import type { Focus, Placement } from './life/interact';
import type { LifeEvent } from './life/life';
import type { LifeState } from './life/state';
import type { ArrowFlight, MeteorFall } from './training';
import type { Actions, GameEvent, Obstacle, PlayerState } from './shapes';
import type { BoxCollider, Deck } from './world/types';
import { answer, wasm, withArrays, withText } from './wasm';

export interface SessionOptions {
  online: boolean;
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

  /** The island. */
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

  /** What's solid in the world as it stands: the regions it holds (places in the world's map), and what's been built since. */
  colliders(): { regions: number[]; obstacles: Obstacle[]; boxes: BoxCollider[]; decks: Deck[] } | null {
    return answer(wasm().session_colliders(this.h));
  }

  /** Hands the world a region grown in the page's worker: its ground the rules', what's on it solid. False if it isn't that region as the world places it. */
  adoptRegion(
    place: number,
    heights: Float32Array,
    surface: Uint8Array,
    clear: Uint8Array,
    edges: Float32Array,
    solids: { obstacles: Obstacle[]; boxes: BoxCollider[]; decks: Deck[] },
  ): boolean {
    const e = wasm();
    const json = new TextEncoder().encode(JSON.stringify(solids));
    return withArrays([heights, surface, clear, edges, json], ([h, s, c, ed, j]) =>
      Boolean(e.session_adopt_region(this.h, place, h[0], h[1], s[0], s[1], c[0], c[1], ed[0], ed[1], j[0], j[1])),
    );
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
