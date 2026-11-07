import { expect, test, vi } from 'vitest';

// New content as data alone (.plans/refactor R9.13). A townsperson with wares and a quest, an item,
// a vehicle and a creature, written as files the way a person adds them to content/ (each copied
// from content/_templates/, as docs/content.md says), live in tests/fixtures/content/. Here they are
// put into a copy of content/ with their ids on the end of their folders' orders, built by contentc
// as content/ is (so every field and reference is checked), and the game reads the bundles they make:
// the engine's rules (given them in place of the bundles built into it) and the page's content and
// windows. Nothing in code knows them, and each is played through the engine as the page plays it
// offline: talked to and bought from, carried and used, followed and handed in, summoned and driven,
// fought.

const fixture = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { build } = await import('../../tools/content/contentc.mjs');
  const from = 'tests/fixtures/content';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruina-new-content-'));
  try {
    fs.cpSync('content', root, { recursive: true });
    const added: string[] = [];
    const copy = (dir: string) => {
      for (const e of fs.readdirSync(path.join(from, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) copy(rel);
        else {
          fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
          fs.copyFileSync(path.join(from, rel), path.join(root, rel));
          added.push(rel);
        }
      }
    };
    copy('');
    // A thing at the top of its kind's folder goes on the end of the folder's order.
    for (const rel of added) {
      const m = /^([^/]+)\/([^/]+)\.json$/.exec(rel);
      if (!m) continue;
      const order = path.join(root, m[1], '_order.json');
      fs.writeFileSync(order, JSON.stringify([...JSON.parse(fs.readFileSync(order, 'utf8')), m[2]]));
    }
    return { bundles: Object.fromEntries(build(root)) as Record<string, any>, added };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
vi.mock('../../shared/items.json', () => ({ default: fixture.bundles['items.json'] }));
vi.mock('../../shared/quests.json', () => ({ default: fixture.bundles['quests.json'] }));
vi.mock('../../shared/vehicles.json', () => ({ default: fixture.bundles['vehicles.json'] }));
vi.mock('../../shared/creatures.json', () => ({ default: fixture.bundles['creatures.json'] }));
vi.mock('../../shared/regions/emberholm.json', () => ({ default: fixture.bundles['regions/emberholm.json'] }));

import { defaultBuild } from '../../src/content/build';
import { itemDef } from '../../src/content/items';
import { QUESTS, questDef } from '../../src/content/quests';
import { rideable } from '../../src/content/vehicles';
import { isAlive } from '../../src/engine/creatures';
import { Engine } from '../../src/engine/engine';
import { type Command, type LifeState, questsAt, type Vehicle } from '../../src/engine/island';
import { type Actions, NO_ACTIONS } from '../../src/engine/rules';
import { useContent } from '../../src/engine/wasm';
import { toWorld, type ZoneNpc } from '../../src/engine/zone';
import type { IslandUI } from '../../src/ui/life/context';
import { questGoal } from '../../src/ui/life/hud/goal';
import { dialogView } from '../../src/ui/life/windows/dialog';

// The engine reads the same bundles as the page's content: given before it reads anything.
useContent(fixture.bundles);

/** A fresh island with you at its spawn, played offline. */
function island(): Engine {
  const e = new Engine({ openWorld: true, online: false, build: defaultBuild() });
  e.life!.drainEvents();
  return e;
}

const step = (e: Engine, frames: number, a: Partial<Actions> = {}) => {
  for (let i = 0; i < frames; i++) e.step({ ...NO_ACTIONS, ...a });
};
/** A command, run on the next step, as a key press or a window sends it. */
const run = (e: Engine, c: Command) => {
  e.command(c);
  step(e, 1);
};
/** Puts you at (x, z) facing `facing`, on the ground, as the developer panel's teleport does, and lets a step see what's in front of you. */
const stand = (e: Engine, x: number, z: number, facing: number) => {
  e.place(x, z, facing);
  step(e, 1);
};
/** In front of someone, facing them. */
const before = (e: Engine, n: ZoneNpc) => stand(e, n.x + Math.sin(n.facing) * 1.6, n.z + Math.cos(n.facing) * 1.6, n.facing + Math.PI);
/** The island taken up again with `change` made to it, as a save brings it back (no time away). */
const retake = (e: Engine, change: (s: LifeState) => void) => {
  const state = structuredClone(e.life!.state);
  change(state);
  const p = e.player;
  expect(e.loadIsland({ savedAt: 0, state, player: { x: p.pos.x, y: p.pos.y, z: p.pos.z, facing: p.facing } }, 0)).toBe(true);
  e.life!.drainEvents();
};
const wren = (e: Engine) => e.world.zone!.recipe.npcs.find((n) => n.id === 'wren')!;
const toasts = (e: Engine) => e.life!.drainEvents().flatMap((ev) => (ev.t === 'toast' ? [ev.text] : []));

test('the new things are content like any other: each in its kind, every reference found', () => {
  expect(fixture.added.length).toBeGreaterThanOrEqual(10);
  const has = (bundle: string, key: string, id: string) =>
    (fixture.bundles[bundle][key] as Array<{ id?: string; npc?: string }>).some((x) => (x.id ?? x.npc) === id);
  expect(has('regions/emberholm.json', 'npcs', 'wren')).toBe(true);
  expect(has('items.json', 'vendors', 'wren')).toBe(true);
  expect(has('items.json', 'items', 'lampOil')).toBe(true);
  expect(has('quests.json', 'quests', 'lamplight')).toBe(true);
  expect(has('vehicles.json', 'vehicles', 'ponyTrap')).toBe(true);
  expect(has('creatures.json', 'creatures', 'mossling')).toBe(true);
});

test('a new townsperson stands on the island, says what their file says and sells their wares', () => {
  const e = island();
  const n = wren(e);
  before(e, n);
  expect(e.life!.focus).toMatchObject({ action: 'talk', npc: 'wren', label: `Talk to ${n.name}`, detail: 'New Quest' });
  run(e, { t: 'interact' });
  expect(e.life!.drainEvents()).toContainEqual({ t: 'open', ui: 'dialog', id: 'wren' });

  // Their window: what they say, their goods and the quest they have for you.
  const ui = {
    life: e.life,
    sim: e.sim,
    world: e.world,
    face: (id: string) => `<face ${e.world.zone!.recipe.npcs.find((x) => x.id === id)?.portrait}>`,
    open: () => {},
  } as unknown as IslandUI;
  const view = dialogView(ui, 'wren');
  expect(view.title).toBe(n.name);
  expect(view.portrait).toBe('<face 🕯️>');
  expect(view.body).toContain(n.greeting);
  expect(view.body).toContain("Browse Wren's Goods");
  expect(view.body).toContain(questDef('lamplight').name);

  // Buying from them: the price their wares ask.
  const coins = e.life!.state.coins;
  run(e, { t: 'buy', npc: 'wren', item: 'lampOil', n: 2 });
  expect(e.life!.count('lampOil')).toBe(2);
  expect(e.life!.state.coins).toBe(coins - 20);
});

test('a new item is what its file says, and using it does what its category does', () => {
  const e = island();
  const oil = itemDef('lampOil');
  expect([oil.cat, oil.use?.labor]).toEqual(['consumable', 40]);
  retake(e, (s) => {
    s.bag.push({ item: 'lampOil', n: 1 });
    s.labor = 100;
  });
  run(e, { t: 'use', item: 'lampOil' });
  // 40 more, and the step it was used in regained a little.
  expect(e.life!.state.labor).toBeCloseTo(140, 1);
  expect(e.life!.count('lampOil')).toBe(0);
  expect(toasts(e)).toEqual(['+40 labor']);
});

test('a new vehicle is summoned from its deed, boarded and driven', () => {
  const e = island();
  // Out on the open farmland, where there's room.
  const fields = e.world.zone!.recipe.farmland;
  stand(e, fields.x, fields.z, 0);
  retake(e, (s) => s.bag.push({ item: 'deed.ponyTrap', n: 1 }));
  run(e, { t: 'use', item: 'deed.ponyTrap' });
  const trap = () => e.life!.land.vehicles.find((x) => x.def === 'ponyTrap') as Vehicle;
  const v = trap();
  expect(v, toasts(e).join('; ')).toBeTruthy();
  expect(rideable('ponyTrap').cargo).toHaveLength(2);
  // Round to the driver's side, in, and away.
  const [ox, oz] = toWorld(1.7, 0.95, v.heading);
  stand(e, v.x + ox, v.z + oz, Math.atan2(-ox, -oz));
  expect(e.life!.focus?.action).toBe('board');
  run(e, { t: 'interact' });
  expect(e.player.mode).toBe('ride');
  step(e, 150, { stickY: 1 });
  expect(Math.hypot(trap().x - v.x, trap().z - v.z)).toBeGreaterThan(5);
});

test('a new quest is offered by its giver, leads where it marks, counts what it asks and pays what it promises', () => {
  const e = island();
  const q = questDef('lamplight');
  expect(questsAt(e.life!, 'wren').offer.map((x) => x.id)).toContain('lamplight');
  // Only this one under way (with the milestones, which lead nowhere), so the marker is its: what
  // starts by itself is behind you.
  retake(e, (s) => {
    s.quests = { active: [], done: QUESTS.filter((x) => x.auto && !x.milestone).map((x) => x.id) };
  });
  run(e, { t: 'accept', quest: 'lamplight' });
  const progress = () => e.life!.state.quests.active.find((x) => x.id === 'lamplight')!;
  const place = (id: string) => e.world.zone!.recipe.places.find((p) => p.id === id)!;

  // Its first step names nowhere, so the marker is where its file says, called as it says.
  expect(questGoal(e.life!, e.sim)).toEqual({ x: place('lanternwick').x, z: place('lanternwick').z, label: q.steps[0].objectives[0].marker?.label });
  const fields = e.world.zone!.recipe.farmland;
  stand(e, fields.x, fields.z, 0);
  retake(e, (s) => s.bag.push({ item: 'deed.ponyTrap', n: 1 }));
  run(e, { t: 'use', item: 'deed.ponyTrap' });
  expect(progress().step).toBe(1);

  // Then the place it names: getting there counts.
  const docks = place('docks');
  expect(questGoal(e.life!, e.sim)).toEqual({ x: docks.x, z: docks.z, label: docks.name });
  stand(e, docks.x, docks.z, 0);
  step(e, 30);
  expect(progress().step).toBe(2);

  // Then back to Wren, who takes it in and pays.
  const n = wren(e);
  expect(questGoal(e.life!, e.sim)).toEqual({ x: n.x, z: n.z, label: n.name });
  before(e, n);
  run(e, { t: 'interact' });
  expect(questsAt(e.life!, 'wren').turnIn.map((x) => x.id)).toEqual(['lamplight']);
  const coins = e.life!.state.coins;
  run(e, { t: 'complete', quest: 'lamplight' });
  expect(e.life!.state.quests.done).toContain('lamplight');
  expect(e.life!.state.coins).toBe(coins + q.rewards.coins!);
  expect(e.life!.count('lampOil')).toBe(2);
});

test('a new creature comes in from its folder and fights by its brain', () => {
  // The training ground, with one mossling a few metres off and the rest of the yard's creatures
  // sent far away, so only it is about.
  const e = new Engine({ openWorld: false, online: false, build: defaultBuild() });
  for (const [i, a] of e.actors.list.entries()) e.setActor(a.id, { x: 200 + i * 4, z: 200, homeX: 200 + i * 4, homeZ: 200 });
  const id = e.spawnActor('mossling', 0, 4);
  const m = () => e.actors.list.find((a) => a.id === id);
  expect([m()?.maxHp, m()?.brain]).toEqual([18, 'mossling']);
  // Stand still: it sees you, runs in and nips.
  const hp = e.player.hp;
  for (let f = 0; f < 600 && e.player.hp >= hp; f++) step(e, 1);
  expect(e.player.hp).toBeLessThan(hp);
  // Fight back until it falls.
  const alive = () => {
    const a = m();
    return a !== undefined && isAlive(a);
  };
  for (let f = 0; f < 1200 && alive(); f++) {
    const a = m()!;
    const dx = a.x - e.player.pos.x;
    const dz = a.z - e.player.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    step(e, 1, { faceX: dx / d, faceZ: dz / d, attackPressed: f % 12 === 0 });
  }
  expect(alive()).toBe(false);
});
