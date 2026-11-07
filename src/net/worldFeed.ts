import { ActorTimeline } from './actorTimeline';
import type { PlayerState } from '../engine/rules';
import type { FeedTick } from './feedTick';

// What the game server says of the world around you, timed to be drawn. The world link
// (src/net/worldLink.ts) brings each tick, and the feed takes it in two parts: your own state as the
// server has it (applyYou: the prediction corrects to it, src/net/netPlayer.ts), and the world around
// you as one FeedTick (applyWorld, src/net/feedTick.ts: the same whichever way the server sends it):
// the monsters near you (drawn between updates, actorTimeline.ts), arrows and meteors in flight, and
// effects to show. Your inputs go out through it, each with the server tick everyone else is drawn
// at, so the server checks your swings against what you saw.

/** The raw per-input bytes: move_x, move_z, buttons, aim_x, aim_z, slot, movement held, face. */
export type RawInput = [number, number, number, number, number, number, number, number];

export interface ArrowRecord {
  id: number;
  owner: number; // player id of the shooter
  /** Yours: drawn from your own guess until this, the server's, takes over. */
  mine: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  team: number;
  /** The server tick this is as of: it flies on from here. */
  tick: number;
}

export interface MeteorRecord {
  id: number;
  x: number;
  z: number;
  ticksLeft: number;
  fallTicks: number;
  team: number;
  radius: number; // the effect's own radius, so any delayedArea draws at its real size
  /** The server tick `ticksLeft` is as of. */
  tick: number;
}

/** One actor as the server sees it. The browser knows the rest from shared/actors.json. */
export interface NetActor {
  id: number;
  /** Index into the kinds in shared/actors.json. */
  kind: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  /** Which behaviour state it is in, and how far through it. */
  state: number;
  progress: number;
  /** 0..1 of its maximum. */
  hp: number;
  /** -1 while alive, otherwise frames since it went down. */
  deadFrame: number;
  /** Where a slam it is winding up will land. */
  targetX: number;
  targetZ: number;
  /** Ticks between its refreshes (1 when left out: every tick). */
  every?: number;
}

/** Something that just happened, for effects: kind 1 heal, 2 explosion, 3 arrow hit (crates/engine/src/combat.rs). */
export interface EffectEvent {
  kind: number;
  x: number;
  y: number;
  z: number;
  size: number;
}

/**
 * Other players (and monsters) are drawn this many server ticks behind the newest update (100 ms
 * at 20 Hz), so there's always a next update to blend toward.
 */
export const INTERP_TICKS = 2;

export class WorldFeed {
  /** Your own state as the server has it, the id it knows you by and the last input it ran. */
  you: { id: number; ack: number; player: PlayerState } | null = null;
  arrows: ArrowRecord[] = []; // arrows in flight near you, as of server tick arrowsTick
  arrowsTick = 0;
  meteors: MeteorRecord[] = [];
  events: EffectEvent[] = []; // effects to show; the game takes them out as it shows them
  /** Monsters, NPCs and props near you, as the server last described them. */
  actors: NetActor[] = [];
  /** The last second of those descriptions, for drawing them between updates (actorTimeline.ts). */
  readonly actorTimeline = new ActorTimeline();
  snapshots = 0; // counts up with every update, so the game can tell when new data has arrived
  lastTick = 0; // server tick of the newest update
  private tickMs = 50;
  private tickOffset: number | null = null; // smoothed (arrival time − tick × tickMs)

  /** `send` takes each input out: its sequence number, the tick drawn (× 16), the bytes and the raw stick. */
  constructor(private send: (seq: number, view: number, raw: RawInput, stick: [number, number]) => void) {}

  /**
   * You've gone into another game (a dungeon's copy, or back out), whose ticks count from
   * somewhere else: what came before is forgotten, and the clock lines up again on the next. So is
   * the last game's word on you: the page has put you where the server says you are now, and its
   * last tick from the game you left, heard just before, would take you back there.
   */
  resetWorld(): void {
    this.you = null;
    this.tickOffset = null;
    this.actors = [];
    this.arrows = [];
    this.meteors = [];
    this.actorTimeline.reset();
  }

  /** Your own state as the server has it, as of `tick`. */
  applyYou(_tick: number, you: { id: number; ack: number; player: PlayerState }): void {
    this.you = you;
    this.snapshots++;
  }

  /** The world around you as of one tick, whichever way it came (src/net/feedTick.ts). */
  applyWorld(feed: FeedTick): void {
    const now = performance.now();
    this.noteTick(feed.tick, now);
    this.arrows = feed.arrows;
    this.meteors = feed.meteors;
    this.events.push(...feed.events);
    this.actorTimeline.push(feed.tick, feed.actors, feed.actorsKept, now);
    this.actors = [...this.actorTimeline.newest()];
    this.arrowsTick = this.lastTick;
    this.snapshots++;
  }

  /** One frame of input: its sequence number, the server tick on screen (× 16, for rewinding hits), and the rounded bytes. */
  sendInput(seq: number, view: number, raw: RawInput, stick: [number, number] = [0, 0]): void {
    this.send(seq, view, raw, stick);
  }

  // Keeps a running estimate of how server ticks line up with this browser's clock.
  private noteTick(tick: number, now: number): void {
    this.lastTick = tick;
    const offset = now - tick * this.tickMs;
    if (this.tickOffset === null || Math.abs(offset - this.tickOffset) > 300) this.tickOffset = offset;
    else this.tickOffset += (offset - this.tickOffset) * 0.05;
  }

  /** The (fractional) server tick that other players and monsters are drawn at right now. */
  renderTick(now: number): number {
    if (this.tickOffset === null) return 0;
    return (now - this.tickOffset) / this.tickMs - INTERP_TICKS;
  }

  get ticksPerSecond(): number {
    return 1000 / this.tickMs;
  }
}
