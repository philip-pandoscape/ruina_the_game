import { beforeAll, expect, test, vi } from 'vitest';

// New content as data alone (.plans/refactor R9.13). A townsperson with wares and a quest, an item,
// a vehicle and a creature, written as files the way a person adds them to content/ (each copied
// from content/_templates/, as docs/content.md says), live in tests/fixtures/content/. Here they are
// put into a copy of content/ with their ids on the end of their folders' orders, built by contentc
// as content/ is (so every field and reference is checked), and the game's rules (the browser's
// copy, src/sim/) and its windows read the bundles they make. Nothing in code knows them, and each is
// played: talked to and bought from, carried and used, followed and handed in, summoned and driven,
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
vi.mock('../../shared/zones/emberholm.json', () => ({ default: fixture.bundles['zones/emberholm.json'] }));

import { itemDef } from '../../src/content/items';
import { questDef } from '../../src/content/quests';
import { rideable } from '../../src/content/vehicles';
import { isAlive } from '../../src/sim/actor';
import { findFocus, runCommand } from '../../src/sim/life/interact';
import { Life } from '../../src/sim/life/life';
import { questsAt } from '../../src/sim/life/quests';
import type { Vehicle } from '../../src/sim/life/state';
import { Sim } from '../../src/sim/sim';
import { type Actions, NO_ACTIONS, type World } from '../../src/sim/types';
import { makeWorld } from '../../src/sim/yard';
import { groundAt } from '../../src/sim/zone/colliders';
import { toWorld } from '../../src/sim/zone/frames';
import type { ZoneNpc } from '../../src/sim/zone/types';
import { makeZoneWorld } from '../../src/sim/zone/world';
import type { IslandUI } from '../../src/ui/life/context';
import { questGoal } from '../../src/ui/life/hud/goal';
import { dialogView } from '../../src/ui/life/windows/dialog';

let world: World;
beforeAll(() => {
  world = makeZoneWorld();
});

/** A fresh island with you at its spawn. */
function island(): { life: Life; sim: Sim } {
  const sim = new Sim(world, { training: false });
  const life = new Life(world.zone!);
  sim.life = life;
  life.afterReset(sim);
  life.drainEvents();
  return { life, sim };
}

/** Puts you at (x, z) facing `facing`, on the ground, as the developer panel's teleport does. */
function stand(sim: Sim, x: number, z: number, facing: number): void {
  const hf = world.terrain!;
  const p = sim.player;
  p.pos = { x, y: groundAt(hf, world.index, x, z, hf.height(x, z) + 1.2, 1.2), z };
  p.prevPos = { ...p.pos };
  p.vel = { x: 0, y: 0, z: 0 };
  p.facing = p.prevFacing = facing;
  p.grounded = true;
}
/** In front of someone, facing them. */
const before = (sim: Sim, n: ZoneNpc) => stand(sim, n.x + Math.sin(n.facing) * 1.6, n.z + Math.cos(n.facing) * 1.6, n.facing + Math.PI);
const step = (sim: Sim, frames: number, a: Partial<Actions> = {}) => {
  for (let i = 0; i < frames; i++) sim.step({ ...NO_ACTIONS, ...a });
};
const wren = () => world.zone!.recipe.npcs.find((n) => n.id === 'wren')!;
const toasts = (life: Life) => life.drainEvents().flatMap((e) => (e.t === 'toast' ? [e.text] : []));

test('the new things are content like any other: each in its kind, every reference found', () => {
  expect(fixture.added.length).toBeGreaterThanOrEqual(10);
  const has = (bundle: string, key: string, id: string) =>
    (fixture.bundles[bundle][key] as Array<{ id?: string; npc?: string }>).some((x) => (x.id ?? x.npc) === id);
  expect(has('zones/emberholm.json', 'npcs', 'wren')).toBe(true);
  expect(has('items.json', 'vendors', 'wren')).toBe(true);
  expect(has('items.json', 'items', 'lampOil')).toBe(true);
  expect(has('quests.json', 'quests', 'lamplight')).toBe(true);
  expect(has('vehicles.json', 'vehicles', 'ponyTrap')).toBe(true);
  expect(has('creatures.json', 'creatures', 'mossling')).toBe(true);
});

test('a new townsperson stands on the island, says what their file says and sells their wares', () => {
  const { life, sim } = island();
  const n = wren();
  before(sim, n);
  expect(findFocus(life, sim)).toMatchObject({ action: 'talk', npc: 'wren', label: `Talk to ${n.name}`, detail: 'New Quest' });
  runCommand(life, sim, { t: 'interact' });
  expect(life.drainEvents()).toContainEqual({ t: 'open', ui: 'dialog', id: 'wren' });

  // Their window: what they say, their goods and the quest they have for you.
  const ui = {
    life,
    sim,
    world,
    face: (id: string) => `<face ${life.zone.recipe.npcs.find((x) => x.id === id)?.portrait}>`,
    open: () => {},
  } as unknown as IslandUI;
  const view = dialogView(ui, 'wren');
  expect(view.title).toBe(n.name);
  expect(view.portrait).toBe('<face 🕯️>');
  expect(view.body).toContain(n.greeting);
  expect(view.body).toContain("Browse Wren's Goods");
  expect(view.body).toContain(questDef('lamplight').name);

  // Buying from them: the price their wares ask.
  const coins = life.state.coins;
  runCommand(life, sim, { t: 'buy', npc: 'wren', item: 'lampOil', n: 2 });
  expect(life.count('lampOil')).toBe(2);
  expect(life.state.coins).toBe(coins - 20);
});

test('a new item is what its file says, and using it does what its category does', () => {
  const { life, sim } = island();
  const oil = itemDef('lampOil');
  expect([oil.cat, oil.use?.labor]).toEqual(['consumable', 40]);
  life.give('lampOil', 1, true);
  life.state.labor = 100;
  runCommand(life, sim, { t: 'use', item: 'lampOil' });
  expect(life.state.labor).toBe(140);
  expect(life.count('lampOil')).toBe(0);
  expect(toasts(life)).toEqual(['+40 labor']);
});

test('a new vehicle is summoned from its deed, boarded and driven', () => {
  const { life, sim } = island();
  // Out on the open farmland, where there's room.
  const fields = world.zone!.recipe.farmland;
  stand(sim, fields.x, fields.z, 0);
  life.give('deed.ponyTrap', 1, true);
  runCommand(life, sim, { t: 'use', item: 'deed.ponyTrap' });
  const v = life.state.vehicles.find((x) => x.def === 'ponyTrap') as Vehicle;
  expect(v, toasts(life).join('; ')).toBeTruthy();
  expect(rideable('ponyTrap').cargo).toHaveLength(2);
  // Round to the driver's side, in, and away.
  const [ox, oz] = toWorld(1.7, 0.95, v.heading);
  stand(sim, v.x + ox, v.z + oz, Math.atan2(-ox, -oz));
  expect(findFocus(life, sim)?.action).toBe('board');
  runCommand(life, sim, { t: 'interact' });
  expect(sim.player.mode).toBe('ride');
  const [x0, z0] = [v.x, v.z];
  step(sim, 150, { stickY: 1 });
  expect(Math.hypot(v.x - x0, v.z - z0)).toBeGreaterThan(5);
});

test('a new quest is offered by its giver, leads where it marks, counts what it asks and pays what it promises', () => {
  const { life, sim } = island();
  const q = questDef('lamplight');
  expect(questsAt(life, 'wren').offer.map((x) => x.id)).toContain('lamplight');
  // Only this one under way, so the marker is its.
  life.state.quests.active = [];
  runCommand(life, sim, { t: 'accept', quest: 'lamplight' });
  const progress = () => life.state.quests.active.find((x) => x.id === 'lamplight')!;
  const place = (id: string) => world.zone!.recipe.places.find((p) => p.id === id)!;

  // Its first step names nowhere, so the marker is where its file says, called as it says.
  expect(questGoal(life, sim)).toEqual({ x: place('lanternwick').x, z: place('lanternwick').z, label: q.steps[0].objectives[0].marker?.label });
  const fields = world.zone!.recipe.farmland;
  stand(sim, fields.x, fields.z, 0);
  life.give('deed.ponyTrap', 1, true);
  runCommand(life, sim, { t: 'use', item: 'deed.ponyTrap' });
  expect(progress().step).toBe(1);

  // Then the place it names: getting there counts.
  const docks = place('docks');
  expect(questGoal(life, sim)).toEqual({ x: docks.x, z: docks.z, label: docks.name });
  stand(sim, docks.x, docks.z, 0);
  step(sim, 30);
  expect(progress().step).toBe(2);

  // Then back to Wren, who takes it in and pays.
  const n = wren();
  expect(questGoal(life, sim)).toEqual({ x: n.x, z: n.z, label: n.name });
  before(sim, n);
  runCommand(life, sim, { t: 'interact' });
  expect(questsAt(life, 'wren').turnIn.map((x) => x.id)).toEqual(['lamplight']);
  const coins = life.state.coins;
  runCommand(life, sim, { t: 'complete', quest: 'lamplight' });
  expect(life.state.quests.done).toContain('lamplight');
  expect(life.state.coins).toBe(coins + q.rewards.coins!);
  expect(life.count('lampOil')).toBe(2);
});

test('a new creature comes in from its folder and fights by its brain', () => {
  // The training ground with one mossling a few metres off.
  const sim = new Sim({ ...makeWorld(), spawns: [{ kind: 'mossling', x: 0, z: 4 }] }, { training: true });
  const m = sim.actorOfKind('mossling')!;
  expect([m.maxHp, m.brain]).toEqual([18, 'mossling']);
  // Stand still: it sees you, runs in and nips.
  const hp = sim.player.hp;
  for (let f = 0; f < 600 && sim.player.hp >= hp; f++) sim.step(NO_ACTIONS);
  expect(sim.player.hp).toBeLessThan(hp);
  // Fight back until it falls.
  for (let f = 0; f < 1200 && isAlive(m); f++) {
    const dx = m.x - sim.player.pos.x;
    const dz = m.z - sim.player.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    sim.step({ ...NO_ACTIONS, faceX: dx / d, faceZ: dz / d, attackPressed: f % 12 === 0 });
  }
  expect(isAlive(m)).toBe(false);
});
