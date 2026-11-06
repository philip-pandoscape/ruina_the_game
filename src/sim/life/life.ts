import type { LifeHooks, Sim } from '../sim';
import type { Actions } from '../types';
import type { ZoneData } from '../zone/world';
import { STEP } from '../../tuning';
import { BAG_SLOTS, itemDef } from '../../content/items';
import { LABOR } from '../../content/trade';
import { FARM } from '../../content/farming';
import { migrateLifeState, newLifeState, type LifeState, type Stack, type Vehicle } from './state';
import { stepWeather } from './weather';
import { stepFarms } from './farming';
import { stepBuyback, stepTrade } from './trade';
import { stepVehicles, rideVehicle } from './vehicles';
import { startQuests, stepQuests, type QuestEvent, notifyQuests } from './quests';
import { findFocus, keepResting, runCommand, type Focus, type Placement } from './interact';
import { stepHousing } from './housing';
import { observe, syncLevels } from './progress';
import type { GameEvent } from '../types';
import { stepContracts } from './contracts';

// The open-world systems as one thing the Sim carries: trade, farming, housing, vehicles,
// quests. It changes only inside step(), from the commands queued since the last one, so the
// same commands on the same frames always give the same world - which is what lets a server run
// it later, with the commands arriving as requests instead of key presses.

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

export interface LifeOptions {
  /** Start-of-game money and labor (tests and the dev panel can be generous). */
  coins?: number;
  labor?: number;
}

export class Life implements LifeHooks {
  state: LifeState;
  focus: Focus | null = null;
  placing: Placement | null = null;
  /** Bumped whenever something the renderer draws from (farms, houses, packs) changes shape. */
  revision = 0;
  private queue: Command[] = [];
  private events: LifeEvent[] = [];
  /**
   * Online, the game server runs the island (crates/engine/src/life): commands go to it instead of running
   * here, what it says happened arrives through fromServer(), and step() only keeps moving what
   * moves with you (the clock, your labor, your vehicles) between its updates.
   */
  remote: ((c: Command) => void) | null = null;
  private relaying = false;
  /** Set during step(), for helpers that need the player. */
  sim!: Sim;

  constructor(
    readonly zone: ZoneData,
    opts: LifeOptions = {},
  ) {
    this.state = newLifeState({ coins: opts.coins ?? 200, labor: opts.labor ?? LABOR.start, seed: zone.recipe.seed });
    // The first quest is waiting the moment you arrive.
    startQuests(this);
  }

  /**
   * Squares the player with the world after the Sim was reset or a save was loaded: a pack the
   * world says is on your back is on your back, nobody is left sitting in a vehicle, and your
   * glider is the one you own.
   */
  afterReset(sim: Sim): void {
    const p = sim.player;
    const back = this.state.packs.find((pk) => pk.at === 'back');
    p.pack = back ? back.id : 0;
    p.vehicle = 0;
    p.seat = 0;
    p.host = 0;
    p.glider = this.state.glider;
    for (const v of this.state.vehicles) v.ridden = false;
    this.placing = null;
    this.resting = false;
    this.sim = sim;
  }

  /** Replaces the whole state (loading a save). */
  load(state: LifeState): void {
    this.state = migrateLifeState(state);
    this.revision++;
    startQuests(this);
  }

  command(c: Command): void {
    if (this.remote) {
      this.remote(c);
      return;
    }
    if (this.queue.length < 64) this.queue.push(c);
  }

  drainEvents(): LifeEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Something the server's island did (a toast, a panel to open), to show here. */
  fromServer(e: LifeEvent): void {
    this.relaying = true;
    this.emit(e);
    this.relaying = false;
  }

  emit(e: LifeEvent): void {
    // Online only the server's island speaks: what this copy predicts would say everything twice.
    if (this.remote && !this.relaying) return;
    this.events.push(e);
    if (this.events.length > 200) this.events.shift();
  }

  toast(text: string, kind: 'good' | 'bad' | 'info' | 'coin' | 'quest' = 'info'): void {
    this.emit({ t: 'toast', text, kind });
  }

  /** Quest progress from anything that happened. */
  notify(e: QuestEvent): void {
    notifyQuests(this, e);
  }

  // ---------- LifeHooks ----------

  ride(sim: Sim, a: Actions): void {
    this.sim = sim;
    rideVehicle(this, sim, a);
  }

  observe(e: GameEvent): void {
    // Online the server counts what you do; this copy only shows what it says.
    if (this.remote) return;
    observe(this, e);
  }

  step(sim: Sim, a: Actions): void {
    this.sim = sim;
    const s = this.state;
    syncLevels(this, sim);
    // Keep the glider you own on your back.
    if (sim.player.glider !== s.glider) sim.player.glider = s.glider;

    if (this.remote) {
      s.clock += STEP;
      this.regenLabor(STEP, this.resting);
      // The rain and the wind from the world's clock, as the server works them out: kept by the
      // server's last word instead, the rain ran early by however far this browser is ahead of it.
      stepWeather(this, STEP, false);
      stepVehicles(this, sim, a);
      this.focus = findFocus(this, sim);
      return;
    }

    for (const c of this.queue.splice(0)) runCommand(this, sim, c);

    s.clock += STEP;
    keepResting(this, sim);
    this.regenLabor(STEP, this.resting);
    stepWeather(this, STEP);
    stepFarms(this, STEP);
    stepTrade(this, STEP);
    stepContracts(this);
    stepVehicles(this, sim, a);
    stepHousing(this);
    stepQuests(this, sim);
    stepBuyback(this, sim);
    if (sim.player.mode === 'glide') s.stats.glideSeconds += STEP;
    this.focus = findFocus(this, sim);
  }

  /** True for the moment you are resting in your own bed. */
  resting = false;

  /**
   * Who else holds a house plot, if anyone (set online from the server's claims; null offline).
   * A plot someone else holds can't be claimed.
   */
  plotOwner: ((plot: string) => string | null) | null = null;

  /**
   * Online: everyone else's vehicles, with whose they are and which of their seats are taken, so the
   * prompt can offer to ride along (src/net/worldPeers.ts; null offline, where nobody else is).
   */
  othersVehicles: (() => OthersVehicle[]) | null = null;

  /**
   * Online: everyone else in your channel, for the prompt to offer a mini-game challenge
   * (src/ui/minigames; null offline, where there's nobody to play).
   */
  othersAround: (() => OtherPlayer[]) | null = null;

  /**
   * The dungeon you're inside a copy of (shared/dungeons/<id>.json), null out on the island: the
   * portals' prompts read it (src/app/dungeonVisit.ts keeps it). Not part of the island.
   */
  dungeon: string | null = null;

  /**
   * Online: the world's clock (the server's, in seconds since 1970), which the rain and the wind run
   * on so that everyone has the same weather (weather.ts); null runs them on the island's own clock.
   */
  worldClock: (() => number) | null = null;

  regenLabor(seconds: number, resting = false, offline = false): void {
    const s = this.state;
    const perMin = offline ? LABOR.offlinePerMinute : LABOR.perMinute * (resting ? LABOR.restMultiplier : 1);
    s.labor = Math.min(LABOR.max, s.labor + (perMin * seconds) / 60);
  }

  // ---------- Randomness: the world's own stream, saved with it ----------

  rand(): number {
    let t = (this.state.rng = (this.state.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  randInt(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }

  nextId(): number {
    return this.state.nextId++;
  }

  // ---------- The bag ----------

  count(item: string): number {
    let n = 0;
    for (const s of this.state.bag) if (s.item === item) n += s.n;
    return n;
  }

  /** Slots the bag would need after adding n of item. */
  private slotsAfter(item: string, n: number): number {
    const def = itemDef(item);
    let used = 0;
    let have = 0;
    for (const s of this.state.bag) {
      if (s.item === item) have += s.n;
      else used++;
    }
    return used + Math.ceil((have + n) / def.stack);
  }

  hasRoom(item: string, n: number): boolean {
    return this.slotsAfter(item, n) <= BAG_SLOTS;
  }

  get slotsUsed(): number {
    return this.state.bag.length;
  }

  /** Adds to the bag; returns how many did not fit. */
  give(item: string, n: number, quiet = false): number {
    if (n <= 0) return 0;
    const def = itemDef(item);
    let left = n;
    for (const s of this.state.bag) {
      if (s.item !== item || s.n >= def.stack) continue;
      const put = Math.min(left, def.stack - s.n);
      s.n += put;
      left -= put;
      if (!left) break;
    }
    while (left > 0 && this.state.bag.length < BAG_SLOTS) {
      const put = Math.min(left, def.stack);
      this.state.bag.push({ item, n: put });
      left -= put;
    }
    const got = n - left;
    if (got && !quiet) this.toast(`+${got} ${def.icon} ${def.name}`, 'good');
    if (left) this.toast(`Your bag is full - ${left} ${def.name} left behind`, 'bad');
    if (got && def.cat === 'seed' && !this.state.seed) this.state.seed = item;
    return left;
  }

  /** Removes from the bag if there are enough; false (and nothing removed) otherwise. */
  take(item: string, n: number): boolean {
    if (this.count(item) < n) return false;
    let left = n;
    const bag = this.state.bag;
    for (let i = bag.length - 1; i >= 0 && left > 0; i--) {
      const s = bag[i];
      if (s.item !== item) continue;
      const out = Math.min(left, s.n);
      s.n -= out;
      left -= out;
      if (s.n <= 0) bag.splice(i, 1);
    }
    return true;
  }

  takeAll(list: Stack[] | undefined): boolean {
    if (!list) return true;
    for (const s of list) if (this.count(s.item) < s.n) return false;
    for (const s of list) this.take(s.item, s.n);
    return true;
  }

  /** Spends money/labor if you have it all; otherwise says what is missing and spends nothing. */
  afford(cost: { coins?: number; seals?: number; labor?: number }, what: string): boolean {
    const s = this.state;
    if ((cost.coins ?? 0) > s.coins) {
      this.toast(`Not enough coin to ${what}`, 'bad');
      return false;
    }
    if ((cost.seals ?? 0) > s.seals) {
      this.toast(`Not enough Charter Seals to ${what}`, 'bad');
      return false;
    }
    if ((cost.labor ?? 0) > s.labor + 1e-6) {
      this.toast(`Too tired - not enough labor to ${what}`, 'bad');
      return false;
    }
    s.coins -= cost.coins ?? 0;
    s.seals -= cost.seals ?? 0;
    s.labor -= cost.labor ?? 0;
    return true;
  }

  /** The player's position, for systems that act around you. */
  get here(): { x: number; y: number; z: number; facing: number } {
    const p = this.sim.player;
    return { x: p.pos.x, y: p.pos.y, z: p.pos.z, facing: p.facing };
  }

  get cellSize(): number {
    return FARM.cell;
  }
}
