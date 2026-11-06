import type { Levels } from '../content/skills';
import type { Build } from '../content/tuning';
import { isAlive, type Actor } from '../sim/actor';
import { startBrain } from '../sim/ai/brain';
import { targetOf } from '../sim/combat/hit';
import { addScarecrowCollider } from '../sim/life/farming';
import { addHouseColliders } from '../sim/life/housing';
import { runCommand, type Placement } from '../sim/life/interact';
import { applySave, type Saved } from '../sim/life/island';
import { Life, type Command } from '../sim/life/life';
import type { House, LifeState, Scarecrow, Vehicle, Weather } from '../sim/life/state';
import { dismount } from '../sim/life/vehicles';
import { Sim } from '../sim/sim';
import { TrainingRange } from '../sim/training';
import type { Actions, GameEvent, Mover, PlayerState, World } from '../sim/types';
import { bandAround, makeWorld } from '../sim/yard';
import { groundAt } from '../sim/zone/colliders';
import { arrivalOf, type DungeonSolids, dungeonDef, floorAt, setDungeonSolid } from '../sim/zone/dungeon';
import { makeZoneWorld } from '../sim/zone/world';
import { type Compared, isShadowing, Shadow } from './shadow';

// The one way into the rules for everything outside them (.plans/refactor R6.4). Today it runs the
// TypeScript rules (src/sim/); Phase 8 runs the same calls on the Rust engine compiled to
// WebAssembly (crates/engine-wasm), and nothing that uses it should notice. So whatever changes the
// rules' state from outside is a call here, named for what it does (R6.0b): putting you somewhere,
// your build, a copy's floors and walls, an island loaded. What it hands out (you, the island's
// state) is for reading.
//
// `sim` and `life` are still public while the modules that take them directly (the island's UI and
// drawing, the network's prediction and peers, the test API) move over to this (R6.4).

export interface EngineOptions {
  /** The open world (Emberholm) rather than the training yard. */
  openWorld: boolean;
  /**
   * Played on the game server, which decides hits: the rules here only predict your own moves,
   * without the training dummy, hit pause or the yard's arrows and meteors.
   */
  online: boolean;
  /** A war-band of that many goblins in the yard's far corner (`?goblins=`). */
  goblins?: number;
  /** Your skills and loadout to start with. */
  build: Build;
  /** A world made elsewhere (the tests' battlefield), in place of the island or the yard. */
  world?: World;
}

export class Engine {
  readonly world: World;
  /** The island's ground (null on the yard's flat ground). */
  readonly terrain: World['terrain'] | null;
  /** Online: the server decides; these rules only predict your own moves. */
  readonly online: boolean;
  readonly sim: Sim;
  /** Offline: the yard's arrows, meteors and heals, against whatever stands about. */
  readonly range: TrainingRange | null;
  /** The island's life systems (trade, farming, housing, vehicles, quests), in the open world. */
  readonly life: Life | null;
  /**
   * Called when a step puts you somewhere by itself (offline, fallen out of the bottom of a copy:
   * back where it's entered), with the way you face, so the camera and auto-run can follow.
   */
  onPlaced: ((facing: number) => void) | null = null;
  /** The dungeon or developer zone you're in a copy of, null out in the world. */
  private dungeon: string | null = null;
  private solids = new Map<string, DungeonSolids>();
  /** Online: your island as the server last sent it, kept as it came (commands run ahead work on a copy). */
  private sent: LifeState | null = null;
  /** In the tests, the engine's own session beside these rules, compared every step (src/engine/shadow.ts). */
  private readonly shadow: Shadow | null;

  constructor(o: EngineOptions) {
    this.online = o.online;
    this.world = o.world ?? (o.openWorld ? makeZoneWorld() : makeWorld());
    if (o.goblins) this.world.spawns.push(...bandAround('goblin', o.goblins, 9, 10, 1));
    this.terrain = this.world.terrain ?? null;
    this.sim = new Sim(this.world, { training: !o.online });
    this.sim.setBuild(o.build);
    // Offline on the island, start standing on the ground at the spawn rather than inside the hill
    // (online the server puts you there, the same way).
    if (this.terrain && !o.online) {
      const p = this.sim.player;
      this.settle(p, p.pos.x, p.pos.z, this.terrain.height(p.pos.x, p.pos.z));
    }
    this.range = o.online ? null : new TrainingRange(this.sim);
    this.life = o.openWorld && this.world.zone ? new Life(this.world.zone) : null;
    if (this.life) this.sim.life = this.life;
    this.shadow = isShadowing() && !o.world && !o.online ? new Shadow({ openWorld: o.openWorld, online: o.online, goblins: o.goblins, build: o.build }) : null;
    this.shadow?.check(this.compared(), 'start');
  }

  /** What these rules show, for the shadow to compare. */
  private compared(): Compared {
    const life = this.life;
    return {
      frame: this.sim.frame,
      player: this.sim.player,
      actors: this.sim.actors.all(),
      missiles: this.sim.actors.missiles,
      life: life ? { state: life.state, focus: life.focus, placing: life.placing, resting: life.resting } : null,
    };
  }

  /** A named call made on the shadow too. */
  private mirror(name: string, args: object = {}): void {
    this.shadow?.call(name, args, () => this.compared());
  }

  /** You, as the rules have you now. */
  get player(): PlayerState {
    return this.sim.player;
  }

  /** Fixed steps taken so far. */
  get frame(): number {
    return this.sim.frame;
  }

  /** The creatures these rules run (offline: online the server's are drawn from its updates). */
  get actors(): Sim['actors'] {
    return this.sim.actors;
  }

  /** What your skills make of your attacks and spells (reach, radius, damage), from your build. */
  get stats(): Sim['stats'] {
    return this.sim.stats;
  }

  /** Ground height under a point: a copy's floor where you're in one, the island's terrain, or 0 on the yard's flat ground. */
  groundY(x: number, z: number): number {
    return this.floorAt(x, z) ?? (this.terrain ? this.terrain.height(x, z) : 0);
  }

  /** What someone at height `near` would stand on at (x, z): the ground, a deck, a roof (0 on the yard's flat ground). */
  standingAt(x: number, z: number, near: number, pad: number): number {
    return this.terrain ? groundAt(this.terrain, this.world.index, x, z, near, pad) : 0;
  }

  /**
   * One fixed step offline: the rules, then the yard's arrows, meteors and heals against whatever
   * stands about. Returns what happened. (Online, the prediction steps the rules: src/net/netPlayer.ts.)
   */
  step(a: Actions): GameEvent[] {
    this.sim.step(a);
    this.catchFall();
    let events = this.sim.drainEvents();
    if (this.range) {
      this.range.step(events);
      events = events.concat(this.sim.drainEvents());
    }
    this.shadow?.step(a, events, this.compared());
    return events;
  }

  /** A command for the island, run on the next step (online, it goes to the server too: the island's remote hook). */
  command(c: Command): void {
    this.life?.command(c);
    this.mirror('command', { command: c });
  }

  /** Your skill levels (in the yard, from the experience earned there; on the island, from your quests). */
  setLevels(levels: Levels): void {
    this.sim.levels = levels;
    this.mirror('setLevels', { levels });
  }

  /** Switches your skills and loadout, as the server does: any attack or cast in progress is dropped. */
  setBuild(b: Build): void {
    this.sim.setBuild(b);
    this.mirror('setBuild', { build: b });
  }

  /**
   * Puts you at (x, z) facing `facing`, standing on whatever is solid under `fromY` there (by default
   * the ground, or the floor of the copy you're in), off whatever you were riding, gliding or
   * swimming in: teleports, and a dungeon's arrival and door.
   */
  place(x: number, z: number, facing: number, fromY?: number): void {
    if (!this.terrain) return;
    if (this.life && this.sim.player.mode === 'ride') dismount(this.life, this.sim);
    const p = this.sim.player;
    this.settle(p, x, z, fromY ?? this.floorHere() ?? this.terrain.height(x, z));
    p.vel = { x: 0, y: 0, z: 0 };
    p.facing = facing;
    p.prevFacing = facing;
    if (p.mode === 'glide' || p.mode === 'swim') p.mode = 'normal';
    this.mirror('place', { x, z, facing, fromY });
  }

  /**
   * Into a copy of a dungeon or developer zone: its floors and walls solid around you, and knocked
   * down in it you get up where it's entered (as the server has it: crates/engine/src/open/dungeon.rs);
   * the island's prompts and weather know you're inside. False if there's no such dungeon here.
   */
  enterDungeon(id: string): boolean {
    const def = dungeonDef(id);
    const index = this.world.index;
    if (!def || !index) return false;
    if (this.dungeon && this.dungeon !== id) this.leaveDungeon();
    this.solids.set(id, setDungeonSolid(index, def, this.solids.get(id) ?? null, true));
    this.dungeon = id;
    this.world.respawnAt = arrivalOf(def);
    if (this.life) this.life.dungeon = id;
    this.mirror('enterDungeon', { id });
    return true;
  }

  /** Out of the copy you're in: its floors and walls gone from your world again. */
  leaveDungeon(): void {
    const id = this.dungeon;
    if (!id) return;
    const def = dungeonDef(id);
    const had = this.solids.get(id);
    if (def && this.world.index && had) setDungeonSolid(this.world.index, def, had, false);
    this.dungeon = null;
    this.world.respawnAt = undefined;
    if (this.life) this.life.dungeon = null;
    this.mirror('leaveDungeon');
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
    return def ? def.origin.y : null;
  }

  /** Which dungeons have been made solid in your world, and whether they still are (tests). */
  solidity(): Record<string, boolean> {
    return Object.fromEntries([...this.solids].map(([k, s]) => [k, s.solid]));
  }

  /**
   * Restores a saved island (an automated test's, or a bug report's) into these rules: its state,
   * the time you were away, where you stood. `now` is the clock `savedAt` was measured on. Returns
   * false, changing nothing, for a save from a newer game than this one.
   */
  loadIsland(data: Saved, now = Date.now()): boolean {
    const loaded = !!this.life && applySave(this.life, this.sim, data, now);
    this.mirror('loadIsland', { data, now });
    return loaded;
  }

  // ---------- Online: what the server says ----------

  /**
   * Online: the server's word on you. You start again from `server` (a copy, which the rules keep),
   * `restore` puts back the parts of the island that move with you as of the same update, then
   * `inputs` (those it hasn't used yet) run again on top: numbered as they were the first time (the
   * frame count is the clock everything is drawn by) and setting nothing off (that was shown
   * already). With none to run you're drawn from where you were, so the last step isn't drawn twice.
   * `first`: the first word since joining, taken as it is.
   */
  correct(server: PlayerState, inputs: readonly Actions[], restore: (() => void) | null, first = false): void {
    const drawnFrom = { ...this.sim.player.prevPos };
    this.sim.player = server;
    restore?.();
    if (first) return;
    this.sim.frame -= inputs.length;
    for (const a of inputs) this.sim.step(a);
    this.sim.drainEvents();
    if (inputs.length === 0) this.sim.player.prevPos = drawnFrom;
  }

  /**
   * Online: your island as a tick has it: its state (kept as it came, not copied), and whether you're
   * placing something or resting.
   */
  takeIsland(island: { state: LifeState; placing: Placement | null; resting: boolean }): void {
    const life = this.life;
    if (!life) return;
    this.sent = island.state;
    life.state = island.state;
    life.placing = island.placing;
    life.resting = island.resting;
  }

  /**
   * Online: a command run here at once as well as on the server (a pack picked up, a seat taken), on
   * a copy of the island the server sent, so that one stays as it came.
   */
  runAhead(c: Command): void {
    const life = this.life;
    if (!life) return;
    if (this.sent && life.state === this.sent) life.state = structuredClone(this.sent);
    runCommand(life, this.sim, c);
  }

  /**
   * Online, before your inputs run again on the server's word on you: the parts of the island that
   * move with you as of that word (its clock, your labor, the weather, your vehicles, resting and
   * placing), and the commands the server hasn't run yet (`ahead`) run again on the island it sent.
   */
  replayIsland(
    you: { clock: number; labor: number; weather: Weather; vehicles: Vehicle[]; resting: boolean; placing: Placement | null },
    ahead: readonly Command[],
  ): void {
    const life = this.life;
    if (!life) return;
    if (ahead.length && this.sent) life.state = structuredClone(this.sent);
    const s = life.state;
    s.clock = you.clock;
    s.labor = you.labor;
    s.weather = you.weather;
    s.vehicles = ahead.length ? structuredClone(you.vehicles) : you.vehicles;
    life.resting = you.resting;
    life.placing = you.placing;
    for (const c of ahead) runCommand(life, this.sim, c);
  }

  /** A house solid here as it is on the server: yours, or someone else's where you see it (`owner`: their island). */
  addSolidHouse(owner: Life, house: House): void {
    addHouseColliders(owner, this.sim, house);
  }

  /** A scarecrow's post solid, and the ground round it tilled, as on the server. */
  addSolidScarecrow(sc: Scarecrow): void {
    addScarecrowCollider(this.sim, sc);
  }

  /** Other players' vehicles where they're drawn, solid to you as yours are. */
  setOthersVehicles(movers: Mover[]): void {
    this.world.movers = movers;
  }

  // ---------- For tests (the test API, src/app/testApi.ts) ----------

  /** Starts you over at `at` with `build`, standing on whatever is solid there, the island's and the yard's parts with you. */
  reset(at: { x: number; z: number; facing: number }, build: Build): void {
    this.sim.reset(at, 0, build);
    const terrain = this.terrain;
    if (terrain) {
      const p = this.sim.player;
      p.pos.y = groundAt(terrain, this.world.index, p.pos.x, p.pos.z, terrain.height(p.pos.x, p.pos.z) + 1.2, 1.2);
      p.prevPos = { ...p.pos };
    }
    this.life?.afterReset(this.sim);
    this.range?.reset();
    this.mirror('reset', { at, build });
  }

  /** Your stamina and MP as they would be part way through a fight. */
  setVitals(v: { stamina?: number; mp?: number }): void {
    if (v.stamina !== undefined) this.sim.player.stamina = v.stamina;
    if (v.mp !== undefined) this.sim.player.mp = v.mp;
    this.mirror('setVitals', v);
  }

  /** Monsters that never get angry, for tests about something else that hits them. */
  calm(on: boolean): void {
    this.sim.actors.calm = on;
    if (on) for (const a of this.sim.actors.all()) a.angry = 0;
    this.mirror('calm', { on });
  }

  /** Puts the `i`th actor of a kind (in spawn order) at (x, z), at home there. */
  placeActor(kind: string, i: number, x: number, z: number): void {
    const a = this.sim.actors.all().filter((v) => v.kind === kind)[i];
    if (!a) return;
    a.x = x;
    a.z = z;
    a.y = 0;
    a.homeX = x;
    a.homeZ = z;
    this.mirror('placeActor', { kind, i, x, z });
  }

  /** Sets fields on an actor (a cooldown, a fuse), to set up a moment directly. */
  setActor(id: number, fields: Partial<Actor>): void {
    const a = this.sim.actors.get(id);
    if (a) Object.assign(a, fields);
    this.mirror('setActor', { id, fields });
  }

  /** A new actor of a kind at (x, z), as if a fight had made it (it won't respawn). Returns its id. */
  spawnActor(kind: string, x: number, z: number): number {
    const a = this.sim.actors.spawn({ kind, x, z, seed: this.testSeed() });
    a.transient = true;
    startBrain(a, this.sim.sighting());
    this.mirror('spawnActor', { kind, x, z });
    return a.id;
  }

  /** A band of `count` of a kind round (x, z), as a zone's spawns make one. Returns their ids. */
  spawnBand(kind: string, count: number, x: number, z: number): number[] {
    const ids = this.sim.spawnBand(kind, count, x, z, this.testSeed());
    this.mirror('spawnBand', { kind, count, x, z });
    return ids;
  }

  /** A blow from you to an actor, as if your weapon had landed it. */
  hurtActor(id: number, amount: number): void {
    const a = this.sim.actors.get(id);
    if (a && isAlive(a)) this.sim.damage(targetOf(a), amount, 0, 0, this.sim.player.weapon);
    this.mirror('hurtActor', { id, amount });
  }

  /** A blow landing on you from (dirX, dirZ), as if something had hit you. */
  takeHit(damage: number, dirX: number, dirZ: number, knock: number): void {
    this.sim.takeHit(damage, dirX, dirZ, knock);
    this.mirror('takeHit', { damage, dirX, dirZ, knock });
  }

  /** A seed for what a test makes, from the moment and how many there are (the same run, the same seed). */
  private testSeed(): number {
    return (this.sim.frame * 2654435761 + this.sim.actors.all().length * 40503) >>> 0;
  }

  /** Offline, fallen out of the bottom of a copy: back where it's entered (the server does this online). */
  private catchFall(): void {
    if (this.online || !this.dungeon) return;
    const def = dungeonDef(this.dungeon);
    if (!def || this.sim.player.pos.y >= def.origin.y + def.fall) return;
    const a = arrivalOf(def);
    this.place(a.x, a.z, a.facing, a.y);
    this.onPlaced?.(a.facing);
  }

  /** Stands `p` at rest on whatever is solid at (x, z) under `near`. */
  private settle(p: PlayerState, x: number, z: number, near: number): void {
    const terrain = this.terrain;
    if (!terrain) return;
    const y = groundAt(terrain, this.world.index, x, z, near + 1.2, 1.2);
    p.pos = { x, y, z };
    p.prevPos = { x, y, z };
    p.grounded = true;
  }
}
