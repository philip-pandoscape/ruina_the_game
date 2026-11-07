import { type Levels, sameLevels } from '../content/skills';
import type { Build } from '../content/tuning';
import type { Actor } from './actors/actor';
import type { Placement } from './life/interact';
import type { SavedLife } from './life/save';
import type { Command, OtherPlayer, OthersVehicle } from './life/life';
import type { LifeState, Weather } from './life/state';
import type { House, Land, Market, Scarecrow, Vehicle } from './life/land';
import type { Actions, GameEvent, Mover, Obstacle, PlayerState, World } from './shapes';
import { ColliderIndex, groundAt } from './world/colliders';
import { arrivalOf, dungeonDef, floorAt } from './world/dungeons';
import { type Ground, Heightfield } from './world/terrain';
import { EMBERHOLM, growRegionHere, type RegionData, worldOf } from './world/region';
import { type WorldLayout, worldLayout } from './world/layout';
import { WorldGround } from './world/worldGround';
import type { BoxCollider, Deck } from './world/types';
import { LifeView } from './lifeView';
import { EngineSession, type SessionView } from './session';
import { RangeView, SimView } from './views';

// The one way into the rules for everything outside them (.plans/refactor R6.4): the engine's own
// rules (crates/engine), compiled to WebAssembly (crates/engine-wasm) and played here as a session
// (src/engine/session.ts), the same rules the server runs (Phase 8). Whatever changes the rules'
// state from outside is a call here, named for what it does: putting you somewhere, your build, a
// copy's floors and walls, an island loaded, the server's word on you. After every step and call
// what the page reads is read back from the session: you and the creatures (`sim`, src/engine/
// views.ts), the island (`life`, src/engine/lifeView.ts), and for drawing and the camera the
// world's colliders whenever what's solid changes. Those are for reading.

export interface EngineOptions {
  /**
   * Played on the game server, which decides hits: the rules here only predict your own moves,
   * without the creatures, their blows, or your arrows and meteors landing.
   */
  online: boolean;
  /** Your skills and loadout to start with. */
  build: Build;
}

/**
 * The world to draw, the page's own copy of it: the region it starts in (Emberholm, where lives belong)
 * grown here, the rest of the world held as the page's worker grows it (adoptRegion). The ground and
 * what's grown on a region are shared; what's solid and the cleared cells are this Engine's (read back
 * from its session).
 */
function openWorld(): { world: World; home: RegionData; ground: WorldGround; layout: WorldLayout } {
  const layout = worldLayout();
  const place = layout.regions.findIndex((r) => r.id === EMBERHOLM.id);
  if (place < 0) throw new Error('the world has no Emberholm');
  const home = growRegionHere(place);
  const ground = new WorldGround(layout);
  ground.hold(place, home.gen.terrain, home.edges);
  const gen = home.gen;
  const w = worldOf(home.recipe, gen);
  const world: World = {
    ...w,
    spawns: [...w.spawns],
    terrain: ground,
    index: new ColliderIndex([...gen.obstacles], [...gen.boxes], [...gen.decks]),
    zone: { recipe: home.recipe, gen: { ...gen, clear: gen.clear.slice() } },
  };
  return { world, home, ground, layout };
}

export class Engine {
  readonly world: World;
  /** In the open world: where its regions stand, and its ground across the regions held and the sea between (the world's terrain while you're out in it). */
  readonly layout: WorldLayout | null = null;
  readonly ground: WorldGround | null = null;
  /** The regions this Engine's world holds, by place: the one it starts in, and those adopted from the page's worker. */
  readonly regions = new Map<number, RegionData>();
  /** The region it starts in (Emberholm, where lives belong), grown here. */
  readonly home: RegionData | null = null;
  /** What's solid on a region the rules grew on the spot (asked about before the page handed it over), by place. */
  private grownHere = new Map<number, { obstacles: Obstacle[]; boxes: BoxCollider[]; decks: Deck[] }>();
  /** In a copy of an instance, the world's ground, set aside until you come back out to it. */
  private outsideTerrain: Ground | undefined;
  /** Online: the server decides; these rules only predict your own moves. */
  readonly online: boolean;
  /** You, the step count, your skills' numbers and the creatures, as the engine last showed them. */
  readonly sim: SimView;
  /** Offline: your arrows and meteors in flight. */
  readonly range: RangeView | null;
  /** The island (trade, farming, housing, vehicles, quests) as the engine last showed it. */
  readonly life: LifeView;
  /**
   * Called when a step puts you somewhere by itself (offline, fallen out of the bottom of a copy:
   * back where it's entered), with the way you face, so the camera and auto-run can follow.
   */
  onPlaced: ((facing: number) => void) | null = null;

  // ---------- Online: what the rules ask the page ----------
  // Read once before each step (and before inputs run again on the server's word on you), so the
  // rules see the same answers all through it.

  /**
   * Online: your commands go to the server, which runs your island (crates/server/src/play), rather
   * than running here. Null drops them (online, until the connection is wired up).
   */
  remote: ((c: Command) => void) | null = null;
  /** Online: the world's clock (the server's, in seconds since 1970), which the rain and the wind run on so that everyone has the same weather; null runs them on the island's own clock. */
  worldClock: (() => number) | null = null;
  /** Online: everyone else's vehicles, with whose they are and which seats are taken, for the prompt to offer to ride along. */
  othersVehicles: (() => OthersVehicle[]) | null = null;
  /** Online: everyone else in your channel, for the prompt to offer a mini-game challenge. */
  othersAround: (() => OtherPlayer[]) | null = null;
  /** Online: the house plots other characters hold (plot id to their name): one someone else holds can't be claimed. */
  plotOwners: (() => Record<string, string>) | null = null;

  private readonly session: EngineSession;
  /** The dungeon or developer zone you're in a copy of, null out in the world. */
  private dungeon: string | null = null;
  /** What's solid as last read back (`SessionView.solid`). */
  private solid: number;
  /** The island's revision as the engine last had it, to tell the page's when it moves. */
  private revision = -1;
  /** What the page last said about everyone else (as JSON), so it's handed over again only when it changes. */
  private toldOthers = '';

  constructor(o: EngineOptions) {
    this.online = o.online;
    this.session = new EngineSession({ online: o.online, build: o.build });
    const open = openWorld();
    this.world = open.world;
    this.layout = open.layout;
    this.ground = open.ground;
    this.home = open.home;
    this.regions.set(open.home.place, open.home);
    const first = this.session.view(false);
    const zone = this.world.zone;
    if (!zone || !first.life) throw new Error('the engine started a session with no world in it');
    this.solid = first.solid;
    this.sim = new SimView(this.world, first.player);
    this.range = o.online ? null : new RangeView();
    this.life = new LifeView(zone, first.life.state, (c) => this.command(c));
    this.take(first);
  }

  /** What the session shows now, taken in (after a step, `v.events` are what happened in it). */
  private take(v: SessionView): void {
    const s = this.sim;
    s.frame = v.frame;
    s.hitstop = v.hitstop;
    s.player = v.player;
    if (!sameLevels(v.levels, s.levels)) s.levels = v.levels;
    s.actors.list = v.actors.list;
    s.actors.missiles = v.actors.missiles;
    if (this.range) {
      this.range.arrows = v.actors.arrows;
      this.range.meteors = v.actors.meteors;
    }
    const life = this.life;
    if (v.life) {
      life.state = v.life.state;
      life.land = v.life.land;
      life.market = v.life.market;
      life.weather = v.life.weather;
      life.now = v.life.now;
      life.focus = v.life.focus;
      life.placing = v.life.placing;
      life.resting = v.life.resting;
      if (v.life.revision !== this.revision) {
        this.revision = v.life.revision;
        life.revision++;
      }
      for (const e of v.said) life.hear(e);
    }
    if (v.solid !== this.solid) {
      this.solid = v.solid;
      this.readColliders();
    }
  }

  /**
   * What's solid and the cleared cells as the session has them, into the world the camera and the
   * drawing use: the colliders of the regions it holds, in the world's order (each as grown, which
   * the page has), then what's been built since.
   */
  private readColliders(): void {
    const index = this.world.index;
    const gen = this.world.zone?.gen;
    if (!index || !gen) return;
    const c = this.session.colliders();
    if (c) {
      const obstacles: Obstacle[] = [];
      const boxes: BoxCollider[] = [];
      const decks: Deck[] = [];
      for (const place of c.regions) {
        const r = this.regions.get(place)?.gen ?? this.solidsGrownHere(place);
        obstacles.push(...r.obstacles);
        boxes.push(...r.boxes);
        decks.push(...r.decks);
      }
      index.take([...obstacles, ...c.obstacles], [...boxes, ...c.boxes], [...decks, ...c.decks]);
    }
    this.session.clear(gen.clear);
  }

  /** What's solid on a region the rules grew on the spot (the page hadn't handed it over yet). */
  private solidsGrownHere(place: number): { obstacles: Obstacle[]; boxes: BoxCollider[]; decks: Deck[] } {
    let s = this.grownHere.get(place);
    if (!s) {
      s = this.session.call<{ obstacles: Obstacle[]; boxes: BoxCollider[]; decks: Deck[] } | null>('regionSolids', { place }) ?? {
        obstacles: [],
        boxes: [],
        decks: [],
      };
      this.grownHere.set(place, s);
    }
    return s;
  }

  // ---------- The world's regions, grown by need (src/app/regions.ts) ----------

  /**
   * Holds a region the page's worker grew (src/engine/world/grower.ts): its ground the rules' and the
   * page's, what's on it solid. False if the rules hold it already (they grew it on the spot) or it
   * isn't that region as the world places it.
   */
  adoptRegion(r: RegionData): boolean {
    if (!this.ground || this.regions.has(r.place)) return false;
    const g = r.gen;
    const taken = this.session.adoptRegion(r.place, g.terrain.heights, g.terrain.surface, g.clear, r.edges, {
      obstacles: g.obstacles,
      boxes: g.boxes,
      decks: g.decks,
    });
    if (!taken) return false;
    this.regions.set(r.place, r);
    this.grownHere.delete(r.place);
    this.ground.hold(r.place, g.terrain, r.edges);
    this.reread();
    return true;
  }

  /** Lets a region go: the rules and the page no longer hold it (what's behind you). */
  releaseRegion(place: number): void {
    if (!this.ground) return;
    this.session.call('releaseRegion', { place });
    this.regions.delete(place);
    this.grownHere.delete(place);
    this.ground.release(place);
    this.reread();
  }

  /** The regions the rules hold (places in the world's map), and how many they've grown on the spot because they were asked about ground the page hadn't handed over. */
  regionsHeld(): { held: number[]; unheld: number } {
    return this.session.call<{ held: number[]; unheld: number }>('regionsHeld');
  }

  /** After a call: what it changed, read back. */
  private reread(): void {
    this.take(this.session.view(false));
  }

  /** You, as the engine has you now. */
  get player(): PlayerState {
    return this.sim.player;
  }

  /** Fixed steps taken so far. */
  get frame(): number {
    return this.sim.frame;
  }

  /** The creatures these rules run (offline: online the server's are drawn from its updates). */
  get actors(): SimView['actors'] {
    return this.sim.actors;
  }

  /** What your skills make of your attacks and spells (reach, radius, damage), from your build. */
  get stats(): SimView['stats'] {
    return this.sim.stats;
  }

  /** Ground height under a point: a copy's floor where you're in one, else the ground of the space you're in. */
  groundY(x: number, z: number): number {
    return this.floorAt(x, z) ?? (this.terrain ? this.terrain.height(x, z) : 0);
  }

  /** What someone at height `near` would stand on at (x, z): the ground, a deck, a roof. */
  standingAt(x: number, z: number, near: number, pad: number): number {
    return this.terrain ? groundAt(this.terrain, this.world.index, x, z, near, pad) : 0;
  }

  /**
   * One fixed step: the rules, and offline your arrows, meteors and heals against whatever stands
   * about. Returns what happened. (Online, the prediction steps the rules: src/net/netPlayer.ts.)
   */
  step(a: Actions): GameEvent[] {
    this.askPage();
    this.session.step(a);
    const v = this.session.view(true);
    this.take(v);
    this.sim.heard(v.events);
    if (v.placed !== null) this.onPlaced?.(v.placed);
    return v.events;
  }

  /**
   * Online: what the rules will ask the page this step (the world's clock, everyone else's vehicles
   * and whereabouts, the plots they hold), asked once and handed to the session.
   */
  private askPage(): void {
    if (!this.online) return;
    this.session.worldClock(this.worldClock?.() ?? null);
    const vehicles = this.othersVehicles?.() ?? [];
    const around = this.othersAround?.() ?? [];
    const plots = this.plotOwners?.() ?? {};
    const others = JSON.stringify({ vehicles, around, plots });
    if (others === this.toldOthers) return;
    this.toldOthers = others;
    this.session.call('others', { vehicles, around, plots });
  }

  /** A command for the island, run on the next step (online, it goes to the server instead: `remote`). */
  command(c: Command): void {
    if (this.online) {
      this.remote?.(c);
      return;
    }
    this.session.call('command', { command: c });
  }

  /** Your skill levels, set outright (tests): the island raises them as your skills learn from use. */
  setLevels(levels: Levels): void {
    this.sim.levels = levels;
    this.session.call('setLevels', { levels });
    this.reread();
  }

  /** Switches your skills and loadout, as the server does: any attack or cast in progress is dropped. */
  setBuild(b: Build): void {
    this.session.call('setBuild', { build: b });
    this.reread();
  }

  /**
   * Puts you at (x, z) facing `facing`, standing on whatever is solid under `fromY` there (by default
   * the ground, or the floor of the copy you're in), off whatever you were riding, gliding or
   * swimming in: teleports, and a dungeon's arrival and door.
   */
  place(x: number, z: number, facing: number, fromY?: number): void {
    if (!this.terrain) return;
    this.session.call('place', { x, z, facing, fromY });
    this.reread();
  }

  /**
   * Into a copy of a dungeon or developer zone: its floors and walls solid around you, and knocked
   * down in it you get up where it's entered (as the server has it: crates/engine/src/open/dungeon.rs);
   * the island's prompts and weather know you're inside. False if there's no such dungeon here.
   */
  enterDungeon(id: string): boolean {
    if (!this.session.call<boolean>('enterDungeon', { id })) return false;
    if (!this.dungeon) this.outsideTerrain = this.world.terrain;
    this.dungeon = id;
    this.life.dungeon = id;
    // Its space has no ground but a long fall under its floors, and no sea: what the page reads of the
    // ground there (the camera, shadows, effects) is the engine's for it, not the world's.
    const g = this.session.call<{ floor: number; water: number } | null>('spaceGround');
    if (g && this.outsideTerrain) this.world.terrain = nothingUnder(g.floor, g.water);
    this.reread();
    return true;
  }

  /** Out of the copy you're in, back in the world. */
  leaveDungeon(): void {
    if (!this.dungeon) return;
    this.session.call('leaveDungeon');
    this.dungeon = null;
    this.life.dungeon = null;
    if (this.outsideTerrain) this.world.terrain = this.outsideTerrain;
    this.outsideTerrain = undefined;
    this.reread();
  }

  /** The ground of the space you're in: the world's, or in a copy of an instance the nothing under its floors. */
  get terrain(): Ground | null {
    return this.world.terrain ?? null;
  }

  /** The dungeon or developer zone you're in a copy of (null out in the world). */
  get inside(): string | null {
    return this.dungeon;
  }

  /** The floor at (x, z) of the copy you're in, where it has one (null out in the world, or off its floor). */
  floorAt(x: number, z: number): number | null {
    const def = this.dungeon ? dungeonDef(this.dungeon) : undefined;
    return def ? floorAt(def, x, z) : null;
  }

  /** The floor's height in the copy you're in (null out in the world). */
  floorHere(): number | null {
    const def = this.dungeon ? dungeonDef(this.dungeon) : undefined;
    return def ? arrivalOf(def).y : null;
  }

  /** Which dungeons have been made solid in your world, and whether they still are (tests). */
  solidity(): Record<string, boolean> {
    return this.session.call<Record<string, boolean>>('solidity');
  }

  /**
   * Restores a saved island (an automated test's, or a bug report's): its state, the time you were
   * away, where you stood. `now` is the clock `savedAt` was measured on. Returns false, changing
   * nothing, for a save from a newer game than this one.
   */
  loadLife(data: SavedLife, now = Date.now()): boolean {
    const loaded = this.session.call<boolean>('loadLife', { data, now });
    this.reread();
    return loaded;
  }

  // ---------- Online: what the server says ----------

  /**
   * Online: the server's word on you. You start again from `server`, `restore` puts back the parts
   * of the island that move with you as of the same update, then `inputs` (those it hasn't used yet)
   * run again on top: numbered as they were the first time (the frame count is the clock everything
   * is drawn by) and setting nothing off (that was shown already). With none to run you're drawn
   * from where you were, so the last step isn't drawn twice. `first`: the first word since joining,
   * taken as it is.
   */
  correct(server: PlayerState, inputs: readonly Actions[], restore: (() => void) | null, first = false): void {
    this.session.call('takePlayer', { player: server });
    restore?.();
    if (!first) {
      this.askPage();
      this.session.call('replay', { inputs, worldClock: this.worldClock?.() ?? null });
    }
    this.reread();
  }

  /**
   * Online: your life as a tick has it: its state, your land, the world's market, and whether you're
   * placing something or resting.
   */
  takeLife(island: { state: LifeState; land: Land; market: Market; placing: Placement | null; resting: boolean }): void {
    this.session.takeLife(island);
    this.reread();
  }

  /**
   * Online: a command run here at once as well as on the server (a pack picked up, a seat taken), on
   * a copy of the island the server sent, so that one stays as it came.
   */
  runAhead(c: Command): void {
    this.session.call('runAhead', { command: c });
    this.reread();
  }

  /**
   * Online, before your inputs run again on the server's word on you: the parts of the island that
   * move with you as of that word (its clock, your labor, the weather, your vehicles, resting and
   * placing), and the commands the server hasn't run yet (`ahead`) run again on the island it sent.
   */
  replayLife(
    you: { clock: number; labor: number; weather: Weather; vehicles: Vehicle[]; resting: boolean; placing: Placement | null },
    ahead: readonly Command[],
  ): void {
    const { clock, labor, weather, vehicles, resting, placing } = you;
    this.session.call('replayLife', { you: { clock, labor, weather, vehicles, resting, placing }, ahead });
  }

  /** A house solid here as it is on the server: yours, or someone else's where you see it (with an id of its own). */
  addSolidHouse(house: House): void {
    this.session.call('addSolidHouse', { house });
    this.reread();
  }

  /** A scarecrow's post solid, and the ground round it tilled, as on the server. */
  addSolidScarecrow(sc: Scarecrow): void {
    this.session.call('addSolidScarecrow', { post: sc });
    this.reread();
  }

  /** Other players' vehicles where they're drawn, solid to you as yours are. */
  setOthersVehicles(movers: Mover[]): void {
    this.world.movers = movers;
    this.session.call('movers', { movers });
  }

  // ---------- For tests (the test API, src/app/testApi.ts) ----------

  /** Starts you over at `at` with `build`, standing on whatever is solid there, with the island's parts and the creatures about you afresh. */
  reset(at: { x: number; z: number; facing: number }, build: Build): void {
    this.session.call('reset', { at, build });
    // A fresh start shows nothing that happened before it.
    this.sim.log.length = 0;
    this.reread();
  }

  /** Your stamina and MP as they would be part way through a fight. */
  setVitals(v: { stamina?: number; mp?: number }): void {
    this.session.call('setVitals', v);
    this.reread();
  }

  /** Monsters that never get angry, for tests about something else that hits them. */
  calm(on: boolean): void {
    this.session.call('calm', { on });
    this.reread();
  }

  /** Puts the `i`th actor of a kind (in spawn order) at (x, z), at home there. */
  placeActor(kind: string, i: number, x: number, z: number): void {
    this.session.call('placeActor', { kind, i, x, z });
    this.reread();
  }

  /** Sets fields on an actor (a cooldown, a fuse), to set up a moment directly. */
  setActor(id: number, fields: Partial<Actor>): void {
    const unknown = this.session.call<string[]>('setActor', { id, fields });
    if (unknown?.length) throw new Error(`setActor: the engine has no ${unknown.join(', ')} to set`);
    this.reread();
  }

  /** A new actor of a kind at (x, z), as if a fight had made it (it won't respawn). Returns its id. */
  spawnActor(kind: string, x: number, z: number): number {
    const id = this.session.call<number>('spawnActor', { kind, x, z });
    this.reread();
    return id;
  }

  /** A band of `count` of a kind round (x, z), as a zone's spawns make one. Returns their ids. */
  spawnBand(kind: string, count: number, x: number, z: number): number[] {
    const ids = this.session.call<number[]>('spawnBand', { kind, count, x, z });
    this.reread();
    return ids;
  }

  /** A blow from you to an actor, as if your weapon had landed it. */
  hurtActor(id: number, amount: number): void {
    this.session.call('hurtActor', { id, amount });
    this.reread();
  }

  /** A blow landing on you from (dirX, dirZ), as if something had hit you. */
  takeHit(damage: number, dirX: number, dirZ: number, knock: number): void {
    this.session.call('takeHit', { damage, dirX, dirZ, knock });
    this.reread();
  }
}

/** A space's ground where there's none: one flat square at `floor` everywhere, the water under it. */
function nothingUnder(floor: number, water: number): Heightfield {
  const hf = new Heightfield(1, 4096, water);
  hf.heights.fill(floor);
  return hf;
}
