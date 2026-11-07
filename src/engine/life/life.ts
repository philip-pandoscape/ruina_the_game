import type { ZoneData } from '../world/region';
import type { Land, Market, Vehicle } from './land';
import type { LifeState, Weather } from './state';

// A life (trade, farming, housing, vehicles, quests) as the page talks to it: the
// commands it sends, what the engine says back, and what the read helpers read. The engine runs the
// commands queued since its last step inside the next one (crates/engine/src/life/mod.rs), so the
// same commands on the same frames always give the same world; online they go to the server as
// requests, and it runs them the same way.

export type Command =
  | { t: 'interact' }
  | { t: 'drop' }
  | { t: 'mount' }
  | { t: 'glider' }
  | { t: 'exit' }
  | { t: 'cycleSeed' }
  | { t: 'use'; item: string }
  | { t: 'buy'; npc: string; item: string; n: number }
  | { t: 'sell'; npc: string; item: string; n: number }
  | { t: 'buyback'; npc: string; item: string; n: number }
  | { t: 'craft'; recipe: string }
  | { t: 'accept'; quest: string }
  | { t: 'complete'; quest: string }
  | { t: 'abandon'; quest: string }
  | { t: 'summon'; item: string }
  | { t: 'recall'; vehicle: number }
  | { t: 'cancelPlace' }
  | { t: 'store'; house: number; item: string; n: number }
  | { t: 'take'; house: number; item: string; n: number }
  | { t: 'payTax'; house: number }
  | { t: 'rest' }
  | { t: 'contract'; id: number }
  | { t: 'gust' }
  | { t: 'grant'; item?: string; n?: number; coins?: number; seals?: number; labor?: number }
  | { t: 'warp'; seconds: number }
  /** The developer panel's teleport: online the channel moves you (offline the page does it itself). */
  | { t: 'teleport'; x: number; z: number; facing?: number }
  /** The developer panel's bots: `n` more round you (`brain`, a skirmisher by default; `team`, yours by default), or with `n` 0 every bot here gone. */
  | { t: 'bots'; n: number; brain?: string; team?: number }
  /** Ride along in another player's vehicle (`host` is their character): the channel seats you. */
  | { t: 'ride'; host: number; vehicle: number };

export type LifeEvent =
  | { t: 'toast'; text: string; kind: 'good' | 'bad' | 'info' | 'coin' | 'quest' }
  | { t: 'open'; ui: 'dialog' | 'shop' | 'craft' | 'storage'; id: string }
  | { t: 'sold'; pack: string; coins: number; seals: number; demand: number; fresh: number; outpost: string }
  | { t: 'harvest'; x: number; y: number; z: number }
  | { t: 'build'; house: number; stage: number; x: number; z: number }
  | { t: 'gather'; x: number; y: number; z: number; kind: string }
  | { t: 'quest'; id: string; what: 'accepted' | 'step' | 'ready' | 'done' | 'abandoned' }
  | { t: 'thunder'; x: number; y: number; z: number };

/**
 * What the helpers the page calls read of a life: its zone, its state and what's in the bag, its
 * land, the world's market and weather where you are, and the land's clock (the engine's snapshot,
 * src/engine/lifeView.ts).
 */
export interface LifeRead {
  readonly zone: ZoneData;
  readonly state: LifeState;
  readonly land: Land;
  readonly market: Market;
  readonly weather: Weather;
  /** The land's clock (seconds): the world's online, the life's own offline. */
  readonly now: number;
  count(item: string): number;
}

/** Another player's vehicle as you see it: whose (their character and name), and the seats taken in it. */
export interface OthersVehicle {
  host: number;
  name: string;
  vehicle: Vehicle;
  taken: number[];
}

/** Another player near you, whom the prompt can offer to challenge to a mini-game (src/ui/minigames). */
export interface OtherPlayer {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Why they can't be challenged right now ('Riding', 'At a Table'...), or null. */
  busy: string | null;
}
