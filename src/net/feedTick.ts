import type { ArrowRecord, EffectEvent, MeteorRecord, NetActor } from './worldFeed';
import type { WorldTick } from './worldLink';

// What the feed takes from each of the server's ticks, whichever way the server sends them: today a
// JSON tick with everyone in the game every tick (feedFromJson, below), and on the wire for crowds
// (crates/wire, src/net/wire/feed.ts) only what's near, each thing refreshed at its own rate. The
// feed (worldFeed.ts, worldPeers.ts, actorTimeline.ts, netSpells.ts) reads this and nothing else of
// the ticks, so switching the server over changes nothing above it.

/** Another player (or a bot) as of one tick: their presence as the feed draws it. */
export interface PeerSample {
  id: number;
  name: string;
  bot: boolean;
  /** Ticks between their refreshes: 1 near; 4 and 20 further off on the wire. */
  every: number;
  /** Not in sight, but something of theirs is (a vehicle, a pack on the ground): nobody to draw. */
  hidden?: boolean;
  /** The fields worldPeers.ts SHOWN reads, its position and velocity, `fr` (60ths of a second), and the vehicles and packs they have out. */
  p: Record<string, unknown>;
}

export interface FeedTick {
  tick: number;
  /** Players with a fresh state this tick. */
  peers: PeerSample[];
  /** Players in sight that weren't refreshed this tick (further off, refreshed less often). Null: everyone in sight is in `peers` (the JSON ticks). */
  kept: number[] | null;
  /** Creatures with a fresh state this tick. */
  actors: NetActor[];
  /** Creatures in sight that weren't refreshed; null as for `kept`. */
  actorsKept: number[] | null;
  /** Every arrow and meteor in flight near you, each as of the tick its state is from. */
  arrows: ArrowRecord[];
  meteors: MeteorRecord[];
  events: EffectEvent[];
}

/** Today's JSON tick, as the feed takes it: everyone near and far, refreshed every tick. */
export function feedFromJson(t: WorldTick): FeedTick {
  const you = t.you?.id;
  return {
    tick: t.tick,
    peers: (t.peers ?? []).map((e) => ({ id: e.id, name: e.name, bot: !!e.bot, every: 1, p: e.p })),
    kept: null,
    actors: t.actors ?? [],
    actorsKept: null,
    arrows: (t.arrows ?? []).map((a) => ({ ...a, mine: a.owner === you, tick: t.tick })),
    meteors: (t.meteors ?? []).map((m) => ({ ...m, tick: t.tick })),
    events: t.events ?? [],
  };
}
