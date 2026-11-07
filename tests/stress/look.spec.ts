import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gameReady } from '../support/game';

// The look test (src/render/look.ts): the same places at the same hours drawn at each quality
// (?quality=high, medium and low), to compare side by side. Screenshots land in
// screenshots/look-<scene>-<quality>.png without the HUD, what each quality costs a frame in
// screenshots/look-perf.json. Tagged @gpu: it captures the screen and times frames.

const QUALITIES = ['high', 'medium', 'low'] as const;

const SHOTS = 'screenshots';
const DAY = JSON.parse(readFileSync('shared/regions/emberholm.json', 'utf8')).sky.dayLengthSeconds as number;

interface Scene {
  id: string;
  /** Where you stand, and which way you face. */
  x: number;
  z: number;
  facing: number;
  /** The hour on Emberholm's clock. */
  hour: number;
  camera: { yaw: number; pitch: number; distance: number };
  /** A parked camera instead, for views from the air: where it is and what it looks at (heights above the ground when `ground`). */
  view?: { from: [number, number, number]; to: [number, number, number]; ground?: boolean };
  /** Inside a copy of this dungeon (content/instances), its floor under you. */
  dungeon?: string;
}

// In order of the hour, so the clock only ever runs forward a little.
const SCENES: Scene[] = [
  { id: 'square-morning', x: 0, z: -264, facing: 0, hour: 9, camera: { yaw: 0.25, pitch: 0.28, distance: 9 } },
  { id: 'aerial-harbour', x: 0, z: -264, facing: 0, hour: 9.5, camera: { yaw: 0, pitch: 0.2, distance: 9 }, view: { from: [60, 140, -520], to: [0, 0, -240] } },
  { id: 'aerial-isle', x: 0, z: -264, facing: 0, hour: 9.7, camera: { yaw: 0, pitch: 0.2, distance: 9 }, view: { from: [420, 330, -760], to: [0, 0, -60] } },
  { id: 'stalls-closeup', x: 6, z: -250, facing: 0.6, hour: 10, camera: { yaw: 0.6, pitch: 0.16, distance: 6 } },
  {
    id: 'windspire-cliffs',
    x: 40,
    z: 110,
    facing: 0,
    hour: 10.5,
    camera: { yaw: 0, pitch: 0.2, distance: 9 },
    view: { from: [95, 26, 70], to: [40, 70, 250] },
  },
  // The falls down the Windspire's face (Goblin's Dread's way in), the goblins' ledge behind them, and the inside.
  {
    id: 'falls-lanternwick',
    x: 40,
    z: 120,
    facing: 0,
    hour: 10.6,
    camera: { yaw: 0, pitch: 0.2, distance: 9 },
    view: { from: [76, 62, 112], to: [52, 92, 220] },
  },
  { id: 'falls-ledge', x: 50.74, z: 220.49, facing: 5.93, hour: 10.7, camera: { yaw: 5.93, pitch: 0.16, distance: 6 } },
  { id: 'dungeon-grotto', x: 0, z: 1.5, facing: 0, hour: 10.8, camera: { yaw: 0, pitch: 0.24, distance: 9 }, dungeon: 'goblinsDread' },
  { id: 'windspire-vista', x: 40, z: 227, facing: Math.PI, hour: 11, camera: { yaw: Math.PI, pitch: 0.12, distance: 7 } },
  {
    id: 'tree-closeup',
    x: 10,
    z: -24,
    facing: 0,
    hour: 11.2,
    camera: { yaw: 0, pitch: 0.2, distance: 9 },
    view: { from: [12, 3.2, -23], to: [1.6, 6, -10.8], ground: true },
  },
  {
    id: 'woods-thornwood',
    x: -262,
    z: 116,
    facing: 0,
    hour: 11.5,
    camera: { yaw: 0, pitch: 0.2, distance: 9 },
    view: { from: [-258, 3.5, 112], to: [-290, 7, 140], ground: true },
  },
  {
    id: 'woods-far',
    x: -40,
    z: 40,
    facing: 0,
    hour: 11.6,
    camera: { yaw: 0, pitch: 0.2, distance: 9 },
    view: { from: [-40, 8, 40], to: [-290, 10, 140], ground: true },
  },
  {
    id: 'north-pines',
    x: 40,
    z: 118,
    facing: 0,
    hour: 11.8,
    camera: { yaw: 0, pitch: 0.2, distance: 9 },
    view: { from: [46, 4, 116], to: [27.8, 8, 146], ground: true },
  },
  {
    id: 'pine-closeup',
    x: -134,
    z: -258,
    facing: 0.7,
    hour: 12.2,
    camera: { yaw: 0.7, pitch: 0.2, distance: 9 },
    view: { from: [-131, 1.8, -261], to: [-139.94, 8.5, -252.21], ground: true },
  },
  {
    id: 'broadleaf-closeup',
    x: -129,
    z: -223,
    facing: 0.7,
    hour: 12.3,
    camera: { yaw: 0.7, pitch: 0.2, distance: 9 },
    view: { from: [-127, 1.8, -223], to: [-136.46, 7.5, -214.38], ground: true },
  },
  { id: 'fields-noon', x: -140, z: -225, facing: -0.8, hour: 12.5, camera: { yaw: -0.8, pitch: 0.22, distance: 10 } },
  { id: 'bushes-edge', x: -258, z: 112, facing: 0.6, hour: 13, camera: { yaw: 0.6, pitch: 0.18, distance: 9 } },
  { id: 'docks-afternoon', x: 2, z: -332, facing: 3.5, hour: 15.5, camera: { yaw: 3.5, pitch: 0.2, distance: 12 } },
  { id: 'hearthside-dusk', x: 142, z: -200, facing: 1.75, hour: 19.3, camera: { yaw: 1.75, pitch: 0.15, distance: 10 } },
  { id: 'square-night', x: 0, z: -264, facing: 0, hour: 22.5, camera: { yaw: 0.25, pitch: 0.28, distance: 9 } },
];

async function open(page: Page, quality: string, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?test&quality=${quality}${extra}`);
  await gameReady(page, 60_000);
  await page.evaluate(() => window.__game.reset());
  await page.waitForFunction(() => window.__game.assetsReady === true, null, { timeout: 60_000 });
  // Just the world: no HUD, windows or prompts over it.
  await page.addStyleTag({ content: 'body > *:not(#game) { visibility: hidden !important; }' });
  return errors;
}

/** Runs the life's clock forward to the hour. */
async function setHour(page: Page, hour: number): Promise<void> {
  const now: number = await page.evaluate(() => window.__game.dayHour());
  const seconds = ((((hour - now) % 24) + 24) % 24) * (DAY / 24);
  if (seconds > 1) await page.evaluate((s) => window.__game.lifeCommand({ t: 'warp', seconds: s }), seconds);
  await page.evaluate(() => window.__game.advance(1));
}

for (const quality of QUALITIES) {
  test(`the look test, ${quality} quality: the same places at the same hours @gpu`, async ({ page }) => {
    const errors = await open(page, quality);
    for (const s of SCENES) {
      await setHour(page, s.hour);
      if (s.dungeon) await page.evaluate((id) => window.__game.visitDungeon(id), s.dungeon);
      await page.evaluate(([x, z, f]) => window.__game.teleport(x, z, f), [s.x, s.z, s.facing] as const);
      await page.evaluate((c) => window.__game.setCamera(c), s.camera);
      await page.evaluate(() => window.__game.advance(40));
      await page.evaluate((v) => {
        const g = window.__game;
        if (!v) return g.viewFrom(null);
        const lift = (p: [number, number, number]): [number, number, number] => (v.ground ? [p[0], p[1] + g.ground(p[0], p[2]), p[2]] : p);
        g.viewFrom(lift(v.from), lift(v.to));
      }, s.view ?? null);
      await page.waitForFunction(() => window.__game.assetsReady === true, null, { timeout: 60_000 });
      await page.screenshot({ path: `${SHOTS}/look-${s.id}-${quality}.png` });
      if (s.dungeon) await page.evaluate(() => window.__game.visitDungeon(null));
    }
    await page.evaluate(() => window.__game.viewFrom(null));
    expect(errors).toEqual([]);
  });
}

test.describe('at 1920 x 1080', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('what each quality costs the graphics card a frame @gpu', async ({ page }) => {
    // Paused, the page still draws every frame, so standing in the square times the drawing alone.
    // Other programs on the card make single readings jumpy, so each quality is loaded three times,
    // in turn, and read every quarter second; the lowest reading is the quality's own cost.
    test.setTimeout(360_000);
    const ms: Record<string, number[]> = { high: [], medium: [], low: [] };
    const work: Record<string, { drawCalls: number; triangles: number; cpuMs: number }> = {};
    for (let round = 0; round < 3; round++) {
      for (const quality of QUALITIES) {
        await open(page, quality);
        await page.evaluate((c) => window.__game.setCamera(c), SCENES[0].camera);
        await page.evaluate(() => window.__game.advance(40));
        await page.waitForTimeout(2000);
        for (let i = 0; i < 12; i++) {
          await page.waitForTimeout(250);
          const p = await page.evaluate(() => window.__game.perf());
          if (p.gpuMs) ms[quality].push(p.gpuMs);
          work[quality] = { drawCalls: p.drawCalls, triangles: p.triangles, cpuMs: p.cpuMs };
        }
      }
    }
    const sum = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return { lowest: +s[0].toFixed(2), median: +s[Math.floor(s.length / 2)].toFixed(2), readings: s.length };
    };
    const result = { viewport: '1920x1080', gpuMsPerFrame: Object.fromEntries(QUALITIES.map((q) => [q, sum(ms[q])])), lastFrame: work };
    console.log('look cost', JSON.stringify(result));
    writeFileSync(`${SHOTS}/look-perf.json`, JSON.stringify(result, null, 2));
    for (const q of QUALITIES) expect(ms[q].length).toBeGreaterThan(0);
  });
});

test('the ambient occlusion on its own, by the market stalls @gpu', async ({ page }) => {
  const errors = await open(page, 'high', '&lookdebug=ao');
  const s = SCENES.find((x) => x.id === 'stalls-closeup')!;
  await setHour(page, s.hour);
  await page.evaluate(([x, z, f]) => window.__game.teleport(x, z, f), [s.x, s.z, s.facing] as const);
  await page.evaluate((c) => window.__game.setCamera(c), s.camera);
  await page.evaluate(() => window.__game.advance(40));
  await page.screenshot({ path: `${SHOTS}/look-ao-stalls.png` });
  expect(errors).toEqual([]);
});
