// Shadow mode (the refactor's R8.5): the engine's session (src/engine/session.ts) runs beside the
// TypeScript rules, every named call the Engine takes is made on both, and after every step (and
// every call) you, the creatures, what happened and the island are compared. The first difference
// is reported (by default it throws, failing the test that made it) and that Engine stops comparing,
// since everything after it differs too. The tests turn it on (tests/support/engineSetup.ts); the
// page never does.

import type { Actor, Missile } from '../sim/actor';
import type { GameEvent, PlayerState } from '../sim/types';
import { EngineSession, type SessionLife, type SessionOptions } from './session';

let shadowing = false;
let report: (difference: string) => void = (d) => {
  throw new Error(d);
};

/** Runs the engine's session beside the TypeScript rules in every Engine made from now on; `onDifference` hears what differs (by default it throws). */
export function shadowRules(on: boolean, onDifference?: (difference: string) => void): void {
  shadowing = on;
  if (onDifference) report = onDifference;
}

export const isShadowing = (): boolean => shadowing;

/** What the Engine shows of its TypeScript rules, for comparing. */
export interface Compared {
  frame: number;
  player: PlayerState;
  actors: readonly Actor[];
  missiles: readonly Missile[];
  life: { state: unknown; focus: unknown; placing: unknown; resting: boolean } | null;
}

/** Where two values differ, as `path: a vs b` lines (at most `limit`). Missing and undefined are the same; numbers compare as numbers. */
export function differences(a: unknown, b: unknown, path = '', out: string[] = [], limit = 12): string[] {
  if (out.length >= limit) return out;
  if (a === b || (a === undefined && b === null) || (a === null && b === undefined)) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return out;
    // A creature's seed may run past 32 bits in the TypeScript; every use reads it mod 2^32.
    if (path.endsWith('.seed') && a >>> 0 === b >>> 0) return out;
    out.push(`${path}: ${a} vs ${b}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: ${a.length} items vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) differences(a[i], b[i], `${path}[${i}]`, out, limit);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) differences(ra[k], rb[k], path ? `${path}.${k}` : k, out, limit);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

/** The engine's session kept beside an Engine's TypeScript rules. */
export class Shadow {
  readonly session: EngineSession;
  private live = true;

  constructor(o: SessionOptions) {
    this.session = new EngineSession(o);
  }

  /** One of the Engine's named calls, made on the session too; then both compared (what it showed comes out with the next step, as the TypeScript's does). */
  call<T = null>(name: string, args: object, now: () => Compared): T | null {
    if (!this.live) return null;
    const out = this.session.call<T>(name, args);
    this.compare(now(), null, name);
    return out;
  }

  /** Both compared as they stand (`after`: what has just happened, for the report). */
  check(now: Compared, after: string): void {
    if (this.live) this.compare(now, null, after);
  }

  /** After a step on both sides: what happened in it (the TypeScript's `events`), and everything after it. */
  step(a: Parameters<EngineSession['step']>[0], events: readonly GameEvent[], now: Compared): void {
    if (!this.live) return;
    this.session.step(a);
    this.compare(now, events, 'step');
  }

  private compare(now: Compared, events: readonly GameEvent[] | null, after: string): void {
    const found: string[] = [];
    if (events) differences(JSON.parse(JSON.stringify(events)), this.session.events(), 'events', found);
    differences(JSON.parse(JSON.stringify(now.player)), this.session.player(), 'player', found);
    const actors = this.session.actors();
    differences(JSON.parse(JSON.stringify(now.actors)), actors.list, 'actors', found);
    differences(JSON.parse(JSON.stringify(now.missiles)), actors.missiles, 'missiles', found);
    if (now.life) {
      const l = this.session.life() as SessionLife;
      differences(JSON.parse(JSON.stringify(now.life)), { state: l.state, focus: l.focus, placing: l.placing, resting: l.resting }, 'life', found);
    }
    if (!found.length) return;
    this.live = false;
    report(`shadow: the engine differs after ${after} at frame ${now.frame}:\n  ${found.join('\n  ')}`);
  }
}
