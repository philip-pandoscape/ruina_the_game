import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The procedural models (src/render/models) in their gallery, dev/models.html. Every category must
// build without a console error and inside its triangle budget, and the parts the rules lean on
// - wheels on the ground, hulls down to their draft, seats, cargo slots, decks and the cottage's
// walls - must be where shared/*.json says. The screenshots in screenshots/ are for a human.

const SHOTS = 'screenshots';
const CATS = ['vehicles', 'mounts', 'gliders', 'packs', 'crops', 'structures', 'props', 'livestock', 'villagers'] as const;
type Cat = (typeof CATS)[number];

/** Triangles per model. */
const BUDGET: Record<Cat, number> = {
  vehicles: 6000,
  structures: 8000,
  crops: 400,
  gliders: 6000,
  mounts: 12000,
  packs: 4000,
  props: 2000,
  livestock: 3000,
  villagers: 3000,
};

interface Stat {
  triangles: number;
  draws: number;
  size: number[];
  min: number[];
  max: number[];
}

type Vec = [number, number, number];
interface Anchor {
  x: number;
  y: number;
  z: number;
  pose?: string;
}

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../shared/${file}`, import.meta.url), 'utf8'));

async function open(page: Page, query: string, errors: string[] = []) {
  if (!errors.length) {
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
  }
  await page.goto(`/dev/models.html?${query}`);
  await page.waitForFunction(() => (window as any).__models?.ready === true, null, { timeout: 90_000 });
  // Let the animations run (wheels, oars, legs, sails) before anything is measured or shot.
  await page.waitForTimeout(600);
  return errors;
}

const stats = (page: Page) => page.evaluate(() => (window as any).__models.stats as Record<string, Stat>);
const probe = (page: Page, label: string, x: number, z: number, from = 60) =>
  page.evaluate(([l, px, pz, f]) => (window as any).__models.probe(l, px, pz, f) as number | null, [label, x, z, from] as const);
const ray = (page: Page, label: string, from: Vec, dir: Vec) =>
  page.evaluate(([l, o, d]) => (window as any).__models.ray(l, o, d) as number[] | null, [label, from, dir] as const);

for (const cat of CATS) {
  test(`${cat}: builds cleanly, within budget`, async ({ page }) => {
    const errors = await open(page, `cat=${cat}`);
    const s = await stats(page);
    expect(Object.keys(s).length).toBeGreaterThan(0);
    for (const [label, st] of Object.entries(s)) {
      if (label.endsWith(':worn')) continue;
      expect.soft(st.triangles, `${label}: triangles`).toBeLessThanOrEqual(BUDGET[cat]);
      expect.soft(st.triangles, `${label}: is empty`).toBeGreaterThan(0);
    }
    await page.screenshot({ path: `${SHOTS}/models-${cat}.png` });
    expect(errors).toEqual([]);
  });
}

test('every vehicle, up close', async ({ page }) => {
  const errors = await open(page, 'cat=vehicles');
  const ids = await page.evaluate(() => (window as any).__models.ids as string[]);
  expect(ids).toEqual(data('vehicles.json').vehicles.map((v: { id: string }) => v.id));
  for (const id of ids) {
    await open(page, `cat=vehicles&only=${id}`, errors);
    await page.screenshot({ path: `${SHOTS}/models-vehicle-${id}.png` });
  }
  expect(errors).toEqual([]);
});

test('vehicles sit on their anchors: wheels on the ground, hulls to their draft, seats and cargo at height', async ({ page }) => {
  await open(page, 'cat=vehicles');
  const s = await stats(page);
  for (const v of data('vehicles.json').vehicles) {
    const st = s[v.name];
    if (v.class === 'wheeled') {
      // Wheel centres at y = r put the lowest point of the model on the ground.
      expect.soft(st.min[1], `${v.id}: lowest point`).toBeGreaterThan(-0.01);
      expect.soft(st.min[1], `${v.id}: lowest point`).toBeLessThan(0.02);
    } else {
      expect.soft(Math.abs(st.min[1] + v.draft), `${v.id}: keel at -draft`).toBeLessThan(0.06);
    }
    for (const seat of v.seats as Anchor[]) {
      if (seat.pose === 'row') continue; // the oars sweep over the rower's thwart
      const y = await probe(page, v.name, seat.x, seat.z, seat.y + 0.8);
      expect.soft(y, `${v.id}: seat at ${seat.x},${seat.z}`).not.toBeNull();
      expect.soft(Math.abs((y ?? 99) - seat.y), `${v.id}: seat top at ${seat.x},${seat.z}`).toBeLessThan(0.04);
    }
    for (const c of v.cargo as Anchor[]) {
      const y = await probe(page, v.name, c.x, c.z, c.y + 1.0);
      expect.soft(Math.abs((y ?? 99) - c.y), `${v.id}: cargo floor at ${c.x},${c.z}`).toBeLessThan(0.08);
    }
  }
});

test('boats keep the sea out: none of it is drawn inside a hull, calm or rocked low in the swell', async ({ page }) => {
  await open(page, 'cat=vehicles');
  // Each boat also pushed down and tipped, far past what the swell does even in a storm, so the sea
  // stands over her floor or deck (the rowboat's is under it anyway) but not over her gunwale.
  const rocked: Record<string, { bob: number; pitch: number; roll: number }> = {
    rowboat: { bob: -0.3, pitch: 0.05, roll: 0.08 },
    sloop: { bob: -0.9, pitch: 0.04, roll: 0.06 },
    cog: { bob: -2.2, pitch: 0.03, roll: 0.05 },
  };
  for (const v of data('vehicles.json').vehicles.filter((v: { class: string }) => v.class === 'boat')) {
    for (const swell of [{}, rocked[v.id] ?? {}]) {
      const r = await page.evaluate(([l, s]) => (window as any).__models.seaInside(l, s), [v.name, swell] as const);
      expect(r, `${v.id}: no hull seal`).not.toBeNull();
      expect(r.of, `${v.id}: the hull's opening`).toBeGreaterThan(5000);
      // The floor, the thwarts, the deck and the cargo hatch as they are without the sea...
      expect(r.inside, `${v.id} ${JSON.stringify(swell)}: the sea shows on ${r.inside} of ${r.of} pixels inside the hull`).toBeLessThan(r.of * 0.002);
      // ...and the sea all round her as it is.
      expect(r.around, `${v.id}: the sea around her`).toBeGreaterThan(0.5);
    }
  }
});

test('mounts: saddle top on the seat, the donkey pack frame on its cargo slot', async ({ page }) => {
  await open(page, 'cat=mounts');
  for (const m of data('vehicles.json').mounts) {
    const label = `${m.name} · walk`;
    const seat = m.seats[0] as Anchor;
    const y = await probe(page, label, seat.x, seat.z, seat.y + 1);
    expect.soft(Math.abs((y ?? 99) - seat.y), `${m.id}: saddle top`).toBeLessThan(0.05);
    for (const c of m.cargo as Anchor[]) {
      const cy = await probe(page, label, c.x, c.z, c.y + 1);
      expect.soft(Math.abs((cy ?? 99) - c.y), `${m.id}: pack frame top`).toBeLessThan(0.05);
    }
  }
});

test('decks, floors and walls are where the structure data puts them', async ({ page }) => {
  await open(page, 'cat=structures');
  const list = data('structures.json').structures as Array<{ id: string; w: number; d: number; deck?: number; floor?: number; wall?: number; door?: number }>;
  const by = (id: string) => list.find((s) => s.id === id)!;
  // Decks: a plank top at the data's height (probed at a plank's middle).
  expect(await probe(page, 'dock', 0.5, 0.16)).toBeCloseTo(by('dock').deck!, 2);
  expect(await probe(page, 'launchDeck', 0.5, 0)).toBeCloseTo(by('launchDeck').deck!, 2);
  // Cottage: floor height, walls on the footprint edges, a door gap through the front wall.
  const c = by('cottage');
  const label = 'cottage · complete';
  expect(await probe(page, label, 1.0, 1.42, 2.5)).toBeCloseTo(c.floor!, 2);
  const side = await ray(page, label, [12, 1.5, 3.0], [-1, 0, 0]); // clear of shutters and chimney
  expect(Math.abs(side![0] - c.w / 2)).toBeLessThan(0.05);
  const inner = await ray(page, label, [0, 1.5, -0.9], [1, 0, 0]);
  expect(Math.abs(inner![0] - (c.w / 2 - c.wall!))).toBeLessThan(0.05);
  const front = await ray(page, label, [2.5, 1.5, 12], [0, 0, -1]);
  expect(Math.abs(front![2] - c.d / 2)).toBeLessThan(0.05);
  const door = await ray(page, label, [0, 1.2, 12], [0, 0, -1]);
  expect(door![2]).toBeLessThan(-c.d / 2 + c.wall! + 0.05); // straight through to the back wall
});

test('packs: straps on the +Z face, the load behind them', async ({ page }) => {
  await open(page, 'cat=packs');
  const s = await stats(page);
  for (const p of data('trade.json').packs) {
    const st = s[p.name];
    expect.soft(st.min[1], `${p.id}: bottom at the origin`).toBeGreaterThan(-0.02);
    expect.soft(st.max[2], `${p.id}: nothing far in front of the straps`).toBeLessThan(0.13);
    expect.soft(st.min[2], `${p.id}: extends back`).toBeLessThan(-0.3);
  }
});

test('crops and props are instancing-ready: non-indexed, vertex-coloured, cached', async ({ page }) => {
  await open(page, 'cat=crops');
  const crops = data('farming.json').crops as Array<{ id: string; stages: number }>;
  const props = data('structures.json').props as Array<{ id: string }>;
  const result = await page.evaluate(
    async ([cropList, propList]) => {
      const cropsPath = '/src/render/models/crops.ts';
      const propsPath = '/src/render/models/props.ts';
      const cm = await import(/* @vite-ignore */ cropsPath);
      const pm = await import(/* @vite-ignore */ propsPath);
      const out: Array<{ name: string; indexed: boolean; colour: boolean; cached: boolean; tris: number }> = [];
      const check = (name: string, g: any, again: any) =>
        out.push({ name, indexed: !!g.index, colour: !!g.getAttribute('color'), cached: g === again, tris: g.getAttribute('position').count / 3 });
      for (const c of cropList) for (let s = 0; s < c.stages; s++) check(`${c.id}:${s}`, cm.cropGeometry(c.id, s), cm.cropGeometry(c.id, s));
      for (const p of propList) check(p.id, pm.propGeometry(p.id), pm.propGeometry(p.id));
      return out;
    },
    [crops, props] as const,
  );
  expect(result.length).toBe(crops.reduce((n, c) => n + c.stages, 0) + props.length);
  for (const r of result) {
    expect.soft(r.indexed, `${r.name}: non-indexed`).toBe(false);
    expect.soft(r.colour, `${r.name}: has colours`).toBe(true);
    expect.soft(r.cached, `${r.name}: cached`).toBe(true);
    if (r.name.includes(':')) expect.soft(r.tris, `${r.name}: triangles`).toBeLessThanOrEqual(400);
  }
});
