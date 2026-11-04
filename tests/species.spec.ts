import { expect, test, type Page } from '@playwright/test';

// Per-species tests. Adding a monster means adding a row to SPECIES and, if it moves in a way
// worth guaranteeing, one motion test below - not a new harness. The numeric assertions read
// baked clip data rather than pixels, so they hold in headless CI; the screenshots are for a
// human to look at afterwards.

const SHOTS = 'screenshots';

interface Loaded {
  id: string;
  joints: number;
  jointNames: string[];
  boxes: number;
  triangles: number;
  height: number;
  clips: Array<{ name: string; frames: number; fps: number; loop: boolean }>;
}

type Vec = [number, number, number];

const harness = async (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/species.html');
  await page.waitForFunction(() => typeof (window as any).__species === 'object');
  return errors;
};

const load = (page: Page, id: string, capacity = 1) =>
  page.evaluate(([i, c]) => (window as any).__species.load(i, c) as Loaded, [id, capacity] as const);

const jointWorld = (page: Page, clip: string, frame: number) =>
  page.evaluate(([c, f]) => (window as any).__species.jointWorld(c, f) as Vec[], [clip, frame] as const);

const bounds = (page: Page, clip: string, frame: number) =>
  page.evaluate(([c, f]) => (window as any).__species.bounds(c, f) as { min: Vec; max: Vec; size: Vec }, [clip, frame] as const);

// What every species must satisfy, whatever shape it is.
const SPECIES = [
  { id: 'fighter', joints: 7, boxes: 20, clips: ['idle', 'run', 'attack', 'down'], still: 'idle' },
  { id: 'slime', joints: 5, boxes: 6, clips: ['idle', 'hop', 'die', 'windup', 'leap'], still: 'idle' },
  { id: 'quadruped', joints: 18, boxes: 19, clips: ['idle', 'walk', 'run'], still: 'idle' },
] as const;

// The crowd budget the box-art fighter set: 240 triangles of body, doubled by its outline hull.
const CROWD_TRIANGLE_BUDGET = 300;

test.describe('species contract', () => {
  for (const spec of SPECIES) {
    test(`${spec.id} loads within the crowd budget`, async ({ page }) => {
      const errors = await harness(page);
      const info = await load(page, spec.id);
      expect(info.joints).toBe(spec.joints);
      expect(info.boxes).toBe(spec.boxes);
      expect(info.triangles).toBe(spec.boxes * 12);
      expect(info.triangles).toBeLessThanOrEqual(CROWD_TRIANGLE_BUDGET);
      expect(info.clips.map((c) => c.name)).toEqual([...spec.clips]);
      expect(info.height).toBeGreaterThan(0.1);
      expect(errors).toEqual([]);
    });

    test(`${spec.id} draws any number of itself in three calls`, async ({ page }) => {
      await harness(page);
      await load(page, spec.id, 2000);
      const one = await page.evaluate((c) => (window as any).__species.grid(1, c), spec.still);
      const many = await page.evaluate((c) => (window as any).__species.grid(2000, c), spec.still);
      // Body, outline hull, ground. Instancing means the count does not move with the crowd.
      expect(one.draws).toBe(3);
      expect(many.draws).toBe(3);
      expect(many.triangles).toBeGreaterThan(one.triangles * 1000);
    });

    test(`${spec.id} holds still when it should`, async ({ page }) => {
      await harness(page);
      const info = await load(page, spec.id);
      const clip = info.clips.find((c) => c.name === spec.still)!;
      // An idle that drifts is a baking bug: the last frame must land back on the first.
      const first = await jointWorld(page, spec.still, 0);
      const last = await jointWorld(page, spec.still, clip.frames - 1);
      for (let j = 0; j < first.length; j++) {
        for (let k = 0; k < 3; k++) expect(Math.abs(first[j][k] - last[j][k])).toBeLessThan(0.05);
      }
    });
  }
});

test.describe('slime', () => {
  test('hop leaves the ground and lands flatter than it started', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'slime');
    const frames = info.clips.find((c) => c.name === 'hop')!.frames;
    const heights: number[] = [];
    const roots: number[] = [];
    for (let f = 0; f < frames; f++) {
      heights.push((await bounds(page, 'hop', f)).max[1]);
      roots.push((await jointWorld(page, 'hop', f))[0][1]);
    }
    const apex = Math.max(...roots);
    expect(apex).toBeGreaterThan(0.35); // it actually jumps
    expect(Math.min(...roots)).toBeLessThan(0.02); // and comes back down
    // Squash on landing: at some frame it is meaningfully shorter than at rest.
    expect(Math.min(...heights)).toBeLessThan(heights[0] * 0.9);
  });

  test('die flattens and stays flat', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'slime');
    const die = info.clips.find((c) => c.name === 'die')!;
    expect(die.loop).toBe(false);
    const start = (await bounds(page, 'die', 0)).size[1];
    const end = (await bounds(page, 'die', die.frames - 1)).size[1];
    expect(end).toBeLessThan(start * 0.4);
  });

  test('has no limbs and still animates', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'slime');
    expect(info.jointNames).toEqual(['root', 'core', 'top', 'budL', 'budR']);
    const a = await bounds(page, 'hop', 0);
    const b = await bounds(page, 'hop', 10);
    expect(a.size).not.toEqual(b.size);
  });
});

test.describe('fighter', () => {
  test('is the same twenty boxes the hardcoded crowd drew', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'fighter');
    // The old renderer reported 240 triangles per fighter; the migration must not change it.
    expect(info.triangles).toBe(240);
    expect(info.jointNames).toEqual(['root', 'body', 'legL', 'legR', 'armL', 'armR', 'cape']);
  });

  test('run is one smooth sinusoidal cycle', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'fighter');
    const frames = info.clips.find((c) => c.name === 'run')!.frames;
    // A joint origin does not move when the joint rotates about itself, so the stride shows up
    // in how far the boxes hanging off it reach, not in jointWorld.
    const reach = async (f: number) => (await bounds(page, 'run', f)).size[2];
    const rest = await reach(0);
    const half = await reach(frames / 2);
    const fore = await reach(frames / 4);
    const back = await reach((frames * 3) / 4);

    // Both zero crossings of the stride are the same pose.
    expect(Math.abs(rest - half)).toBeLessThan(0.01);
    // The two extremes sit either side of it, and the cycle covers real ground.
    expect(fore).toBeLessThan(rest - 0.1);
    expect(back).toBeGreaterThan(rest + 0.1);
    expect(back - fore).toBeGreaterThan(0.4);
  });

  test('the chop reaches behind the head and comes back', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'fighter');
    const attack = info.clips.find((c) => c.name === 'attack')!;
    expect(attack.loop).toBe(false);
    // The sword hangs off armR; at the top of the wind-up it is behind and above the fighter.
    let highest = -Infinity;
    let back = -Infinity;
    for (let f = 0; f < attack.frames; f++) {
      const b = await bounds(page, 'attack', f);
      highest = Math.max(highest, b.max[1]);
      back = Math.max(back, -b.min[2]);
    }
    const rest = await bounds(page, 'attack', attack.frames - 1);
    expect(highest).toBeGreaterThan(rest.max[1] + 0.2); // the blade goes up
    expect(back).toBeGreaterThan(0.3); // and behind
  });

  test('down lays the fighter out flat', async ({ page }) => {
    await harness(page);
    await load(page, 'fighter');
    const info = await load(page, 'fighter');
    const at = (n: string) => info.jointNames.indexOf(n);
    const up = await jointWorld(page, 'idle', 0);
    const flat = await jointWorld(page, 'down', 0);
    // The body goes over: every joint above the waist ends up near the ground and well behind
    // where it stood. The bounding box is no use here - the sword swings upward as the fighter
    // falls, exactly as it did under the old shader, so the box stays tall.
    for (const joint of ['armL', 'armR', 'cape']) {
      const j = at(joint);
      expect(up[j][1]).toBeGreaterThan(1);
      expect(flat[j][1]).toBeLessThan(0.35);
      expect(flat[j][2]).toBeLessThan(up[j][2] - 0.7);
    }
    expect((await bounds(page, 'down', 0)).size[2]).toBeGreaterThan((await bounds(page, 'idle', 0)).size[2] * 1.2);
  });
});

test.describe('quadruped', () => {
  test('walks on four legs in a diagonal gait', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'quadruped');
    const at = (name: string) => info.jointNames.indexOf(name);
    const frames = info.clips.find((c) => c.name === 'walk')!.frames;

    // Diagonal pairs share a phase, so their feet swing together; neighbours do not.
    const swing = async (joint: string) => {
      const zs: number[] = [];
      for (let f = 0; f < frames; f += 2) zs.push((await jointWorld(page, 'walk', f))[at(joint)][2]);
      return zs;
    };
    const fl = await swing('footFL');
    const br = await swing('footBR');
    const fr = await swing('footFR');

    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(spread(fl)).toBeGreaterThan(0.1); // the legs actually move

    // Same-phase pair rises and falls together; opposite-phase pair does not.
    const centred = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return v.map((x) => x - m); };
    const corr = (a: number[], b: number[]) => {
      const [x, y] = [centred(a), centred(b)];
      const dot = x.reduce((s, v, i) => s + v * y[i], 0);
      return dot / Math.sqrt(x.reduce((s, v) => s + v * v, 0) * y.reduce((s, v) => s + v * v, 0));
    };
    expect(corr(fl, br)).toBeGreaterThan(0.9);
    expect(corr(fl, fr)).toBeLessThan(-0.5);
  });

  test('keeps its feet near the ground', async ({ page }) => {
    await harness(page);
    const info = await load(page, 'quadruped');
    const frames = info.clips.find((c) => c.name === 'walk')!.frames;
    const feet = ['footFL', 'footFR', 'footBL', 'footBR'].map((n) => info.jointNames.indexOf(n));
    let lowest = Infinity;
    for (let f = 0; f < frames; f += 2) {
      const p = await jointWorld(page, 'walk', f);
      for (const i of feet) {
        expect(p[i][1]).toBeLessThan(0.45); // never lifts to mid-body
        lowest = Math.min(lowest, p[i][1]);
      }
    }
    expect(lowest).toBeLessThan(0.2); // and at least one is always planted low
  });
});

test.describe('looks right', () => {
  for (const spec of SPECIES) {
    test(`${spec.id} renders`, async ({ page }) => {
      const errors = await harness(page);
      await load(page, spec.id, 400);
      const moving = (await load(page, spec.id, 400)).clips.find((c) => c.name !== spec.still)?.name ?? spec.still;
      await page.evaluate((c) => (window as any).__species.solo(c, 0.4), moving);
      await page.screenshot({ path: `${SHOTS}/species-${spec.id}-solo.png` });
      await page.evaluate((c) => (window as any).__species.grid(400, c), moving);
      await page.screenshot({ path: `${SHOTS}/species-${spec.id}-crowd.png` });
      expect(errors).toEqual([]);
    });
  }
});

// ---------- baked from the close-up poses ----------

test.describe('hero', () => {
  test('its crowd body is the close-up body, boxed', async ({ page }) => {
    await harness(page);
    const hero = await load(page, 'hero');
    // 18 worn parts plus the five pieces of the sword it is baked holding.
    expect(hero.boxes).toBe(23);
    expect(hero.triangles).toBe(23 * 12);
    expect(hero.joints).toBe(16);
    expect(hero.height).toBeGreaterThan(1.5);
    expect(hero.height).toBeLessThan(1.9);
    expect(hero.clips.map((c) => c.name)).toContain('run');
    expect(hero.clips.find((c) => c.name === 'down')!.loop).toBe(false);
  });

  // The whole point of baking: a hero in a battle is running the same animation as the hero
  // standing in front of you. If these ever disagree, the crowd has drifted from the game.
  for (const [clip, frame] of [['run', 7], ['run', 19], ['idle', 30], ['attack1', 9], ['down', 0]] as const) {
    test(`the baked ${clip} clip matches the live pose on frame ${frame}`, async ({ page }) => {
      await harness(page);
      await load(page, 'hero');
      const live = await page.evaluate(
        ([c, f]) => (window as any).__species.poseWorld('hero', c, f) as Promise<Array<[string, number, number, number]>>,
        [clip, frame] as const,
      );
      const baked = await jointWorld(page, clip, frame);
      expect(baked).toHaveLength(live.length);
      live.forEach(([name, x, y, z], i) => {
        const b = baked[i];
        const off = Math.hypot(b[0] - x, b[1] - y, b[2] - z);
        if (off > 1e-3) throw new Error(`${clip} frame ${frame}: joint ${name} is at ${[x, y, z]} live and ${b} baked`);
      });
    });
  }
});
