import { Vector3 } from 'three';
import { test as base } from 'vitest';
import { defaultBuild, validBuild } from '../../src/content/build';
import { NODES } from '../../src/content/skills';
import type { Build } from '../../src/content/tuning';
import { readOptions } from '../../src/app/options';
import { savedIsland } from '../../src/app/save';
import { loadBuild } from '../../src/app/savedBuild';
import { migrateStorage } from '../../src/app/storage';
import { makeStep } from '../../src/app/step';
import { makeTestApi } from '../../src/app/testApi';
import { Engine } from '../../src/engine/engine';
import { skillBudget, type Command } from '../../src/engine/life';
import { dungeonDef } from '../../src/engine/zone';
import { DungeonVisit } from '../../src/app/dungeonVisit';
import { FollowCamera } from '../../src/render/camera';
import { AutoWalk } from '../../src/input/autoWalk';
import type { NetActor } from '../../src/net/worldFeed';
import type { GameRefs } from '../../src/main';

// The game without a page (.plans/refactor R6.2a): the rules through the engine (src/engine/), the
// island's life, auto-walk and the camera's maths for real; in place of the drawing, the windows,
// the controller and the server, stand-ins that do nothing. The step
// (src/app/step.ts) and the test API (src/app/testApi.ts) run on it as they run on the page, so a
// rules test written for a page (page.evaluate over window.__game) runs here unchanged: `test` gives
// it a `page` whose goto() starts the game headless from the same address (`/?test`, the world;
// `/?test=yard`, a copy of an instance) and whose evaluate() runs the function here. What only a
// page has (the windows, the scene, the picture, the server) throws when reached, naming it: a test
// that needs it stays in tests/integration.

/** Stands in for drawing and effects: whatever is asked of it, it does nothing. */
const nothing: unknown = new Proxy(() => undefined, {
  get: (_t, k) => (k === Symbol.toPrimitive || k === 'then' ? undefined : nothing),
  apply: () => undefined,
});

/** Stands in for what only a page has: reaching it fails the test, saying what it reached for. */
function pageOnly(what: string): unknown {
  return new Proxy(() => undefined, {
    get: (_t, k) => {
      if (k === 'then' || k === Symbol.toPrimitive) return undefined;
      throw new Error(`headless: ${what}.${String(k)} needs a page (keep this test in tests/integration)`);
    },
    apply: () => {
      throw new Error(`headless: ${what}() needs a page (keep this test in tests/integration)`);
    },
  });
}

/** Browser storage, kept in memory: a page's own, empty when it opens. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(i: number): string | null {
    return [...this.items.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
}

/** The game offline at `url`, as src/main.ts starts it, without drawing anything. */
function start(url: string) {
  const opt = readOptions(new URL(url, 'http://headless').search);
  migrateStorage(localStorage);
  let build: Build = loadBuild();
  const engine = new Engine({ online: false, build });
  const { world, terrain, sim, range, life } = engine;
  // As main.ts: the island kept in this browser when asked for.
  if (opt.test && opt.load) {
    const saved = savedIsland();
    if (saved) engine.loadIsland(saved);
  }
  // As main.ts: into a copy of a dungeon and out again, with nothing to draw; started in a copy of
  // an instance the address names (?test=yard), as if through its door.
  const visit = new DungeonVisit({ engine, stage: null, place: (x, y, z, facing) => engine.place(x, z, facing, y) });
  if (opt.space) visit.enterDungeonHere(opt.space, true);
  // What main.ts does with these offline.
  // A developer zone is for trying weapons and skills: the whole tree.
  const skillPoints = (): number => {
    const inside = engine.inside ? dungeonDef(engine.inside) : undefined;
    if (inside?.developer) return NODES.length;
    return skillBudget(life.state);
  };
  // As main.ts: a build held to the points you may spend where you are.
  if (!validBuild(build, skillPoints())) {
    build = defaultBuild();
    engine.setBuild(build);
  }
  const follow = new FollowCamera(16 / 9, 320, 40);
  follow.reset(world.spawn.facing);
  const walker = new AutoWalk({ sim, world, life });
  const at = new Vector3();
  const followSim = (dt: number): void => {
    const p = sim.player.pos;
    follow.update(at.set(p.x, p.y, p.z), dt);
  };
  const applyBuild = (b: Build): void => {
    build = b;
    engine.setBuild(b);
  };
  const islandCommand = (c: Command): void => engine.command(c);
  const teleport = (x: number, z: number, facing = engine.player.facing): void => {
    if (!terrain) return;
    walker?.stop();
    engine.place(x, z, facing);
  };
  const drawing = { showEvent: () => undefined, draw: () => undefined, followSim, pinnedView: null, blob: nothing };
  const scripted: unknown[] = [];
  const parts: Record<string, unknown> = {
    engine,
    world,
    terrain,
    sim,
    range,
    life,
    follow,
    walker,
    get build() {
      return build;
    },
    set build(b: Build) {
      build = b;
    },
    applyBuild,
    skillPoints,
    islandCommand,
    teleport,
    groundY: (x: number, z: number) => engine.groundY(x, z),
    dummyActor: () => sim.actorOfKind('dummy'),
    drawing,
    draw: drawing.draw,
    followSim,
    scripted,
    shownActors: [] as NetActor[],
    presentActors: [] as NetActor[],
    shownById: new Map<number, NetActor>(),
    testMode: opt.test,
    serverRules: false,
    // Offline and headless: no server, no windows over the island, nobody else.
    online: null,
    net: null,
    prediction: null,
    netSpells: null,
    netMonsters: null,
    peers: null,
    minigames: null,
    party: null,
    visit,
    bugs: null,
    lifeUI: null,
    openStage: null,
    frozen: false,
    paused: true,
    // Drawing and effects: nothing to draw them on.
    vfx: nothing,
    hud: nothing,
    hero: nothing,
    input: nothing,
    spells: nothing,
    // The skill book and tree keep up with your build; headless there's no window to show it.
    panel: nothing,
  };
  const refs = new Proxy(parts, {
    get: (t, k) => (typeof k === 'string' && !(k in t) ? pageOnly(k) : Reflect.get(t, k)),
  }) as unknown as GameRefs;
  const step = makeStep(refs);
  parts.stepOnce = step.stepOnce;
  parts.syncNet = step.syncNet;
  return makeTestApi(refs);
}

/** A page as far as a rules test uses one: goto() starts the game, evaluate() runs a function on it. */
export class HeadlessPage {
  private api: ReturnType<typeof start> | null = null;
  private storage = new MemoryStorage();
  private initScripts: (() => void)[] = [];

  async goto(url: string): Promise<null> {
    const g = globalThis as unknown as { window: unknown; localStorage: Storage; __game: unknown };
    g.window = globalThis;
    g.localStorage = this.storage;
    for (const run of this.initScripts) run();
    this.api = start(url);
    g.__game = this.api;
    return null;
  }

  /** Runs before the game starts at each goto(), as a page's init script runs before its scripts. */
  async addInitScript<A>(fn: (arg: A) => unknown, arg?: A): Promise<void> {
    this.initScripts.push(() => fn(arg as A));
  }

  /** A page's console and errors: headless, an error is thrown where it happens and fails the test. */
  on(_event: 'console' | 'pageerror', _listener: (m: { type(): string; text(): string }) => unknown): this {
    return this;
  }

  async evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    if (!this.api) throw new Error('headless: goto() first');
    return await fn(arg as A);
  }

  /** A picture of the page, kept for people to look at: headless there's nothing to take. */
  async screenshot(_opts?: unknown): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  /** As the page's: headless, it's ready as soon as it has started. */
  async waitForFunction(): Promise<void> {}
}

/**
 * Vitest's test, with a headless `page` for each test as Playwright's gives a real one, and
 * Playwright's setTimeout (headless, the test's own timeout in vitest.config.ts covers it).
 */
export const test = Object.assign(
  base.extend<{ page: HeadlessPage }>({
    // biome-ignore lint/correctness/noEmptyPattern: Vitest's fixtures take their dependencies first.
    page: async ({}, use) => {
      await use(new HeadlessPage());
    },
  }),
  { setTimeout: (_ms: number): void => undefined },
);

/** The game is ready once goto() has returned (src/main.ts's start-up, headless, is synchronous). */
export async function gameReady(_page: HeadlessPage, _timeout?: number): Promise<void> {}

export type Page = HeadlessPage;
