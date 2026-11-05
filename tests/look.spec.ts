import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The look test (?look=new, src/render/look.ts): the same places at the same hours drawn in the
// classic look and in the new one, to compare side by side. Screenshots land in
// screenshots/look-<scene>-<look>.png without the HUD, frame times in screenshots/look-perf-<look>.json.
// Tagged @gpu: it captures the screen and times frames.

const SHOTS = 'screenshots';
const DAY = JSON.parse(readFileSync('shared/zones/emberholm.json', 'utf8')).sky.dayLengthSeconds as number;

interface Scene {
  id: string;
  /** Where you stand, and which way you face. */
  x: number;
  z: number;
  facing: number;
  /** The hour on Emberholm's clock. */
  hour: number;
  camera: { yaw: number; pitch: number; distance: number };
  /** A parked camera instead, for views from the air: where it is and what it looks at. */
  view?: { from: [number, number, number]; to: [number, number, number] };
}

// In order of the hour, so the clock only ever runs forward a little.
const SCENES: Scene[] = [
  { id: 'square-morning', x: 0, z: -264, facing: 0, hour: 9, camera: { yaw: 0.25, pitch: 0.28, distance: 9 } },
  { id: 'aerial-harbour', x: 0, z: -264, facing: 0, hour: 9.5, camera: { yaw: 0, pitch: 0.2, distance: 9 }, view: { from: [60, 140, -520], to: [0, 0, -240] } },
  { id: 'aerial-isle', x: 0, z: -264, facing: 0, hour: 9.7, camera: { yaw: 0, pitch: 0.2, distance: 9 }, view: { from: [420, 330, -760], to: [0, 0, -60] } },
  { id: 'stalls-closeup', x: 6, z: -250, facing: 0.6, hour: 10, camera: { yaw: 0.6, pitch: 0.16, distance: 6 } },
  { id: 'windspire-cliffs', x: 40, z: 110, facing: 0, hour: 10.5, camera: { yaw: 0, pitch: 0.2, distance: 9 }, view: { from: [95, 26, 70], to: [40, 70, 250] } },
  { id: 'windspire-vista', x: 40, z: 227, facing: Math.PI, hour: 11, camera: { yaw: Math.PI, pitch: 0.12, distance: 7 } },
  { id: 'fields-noon', x: -140, z: -225, facing: -0.8, hour: 12.5, camera: { yaw: -0.8, pitch: 0.22, distance: 10 } },
  { id: 'docks-afternoon', x: 2, z: -332, facing: 3.5, hour: 15.5, camera: { yaw: 3.5, pitch: 0.2, distance: 12 } },
  { id: 'hearthside-dusk', x: 142, z: -200, facing: 1.75, hour: 19.3, camera: { yaw: 1.75, pitch: 0.15, distance: 10 } },
  { id: 'square-night', x: 0, z: -264, facing: 0, hour: 22.5, camera: { yaw: 0.25, pitch: 0.28, distance: 9 } },
];

async function open(page: Page, look: string, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?world&test${look === 'new' ? '&look=new' : ''}${extra}`);
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__game.reset());
  await page.waitForFunction(() => (window as any).__game.assetsReady === true, null, { timeout: 60_000 });
  // Just the world: no HUD, windows or prompts over it.
  await page.addStyleTag({ content: 'body > *:not(#game) { visibility: hidden !important; }' });
  return errors;
}

/** Runs the island's clock forward to the hour. */
async function setHour(page: Page, hour: number): Promise<void> {
  const now: number = await page.evaluate(() => (window as any).__game.dayHour());
  const seconds = ((((hour - now) % 24) + 24) % 24) * (DAY / 24);
  if (seconds > 1) await page.evaluate((s) => (window as any).__game.lifeCommand({ t: 'warp', seconds: s }), seconds);
  await page.evaluate(() => (window as any).__game.advance(1));
}

for (const look of ['classic', 'new']) {
  test(`the look test, ${look}: the same places at the same hours @gpu`, async ({ page }) => {
    const errors = await open(page, look);
    for (const s of SCENES) {
      await setHour(page, s.hour);
      await page.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), [s.x, s.z, s.facing] as const);
      await page.evaluate((c) => (window as any).__game.setCamera(c), s.camera);
      await page.evaluate(() => (window as any).__game.advance(40));
      await page.evaluate((v) => (window as any).__game.viewFrom(v ? v.from : null, v?.to), s.view ?? null);
      await page.waitForFunction(() => (window as any).__game.assetsReady === true, null, { timeout: 60_000 });
      await page.screenshot({ path: `${SHOTS}/look-${s.id}-${look}.png` });
    }
    await page.evaluate(() => (window as any).__game.viewFrom(null));
    expect(errors).toEqual([]);
  });
}

test.describe('at 1920 x 1080', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('what each look costs the graphics card a frame @gpu', async ({ page }) => {
    // Paused, the page still draws every frame, so standing in the square times the drawing alone.
    // Other programs on the card make single readings jumpy, so each look is loaded three times,
    // in turn, and read every quarter second; the lowest reading is the look's own cost.
    test.setTimeout(240_000);
    const ms: Record<string, number[]> = { classic: [], new: [] };
    for (let round = 0; round < 3; round++) {
      for (const look of ['classic', 'new']) {
        await open(page, look);
        await page.evaluate((c) => (window as any).__game.setCamera(c), SCENES[0].camera);
        await page.evaluate(() => (window as any).__game.advance(40));
        await page.waitForTimeout(2000);
        for (let i = 0; i < 12; i++) {
          await page.waitForTimeout(250);
          const p = await page.evaluate(() => (window as any).__game.perf());
          if (p.gpuMs) ms[look].push(p.gpuMs);
        }
      }
    }
    const sum = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return { lowest: +s[0].toFixed(2), median: +s[Math.floor(s.length / 2)].toFixed(2), readings: s.length };
    };
    const result = { viewport: '1920x1080', gpuMsPerFrame: { classic: sum(ms.classic), new: sum(ms.new) } };
    console.log('look cost', JSON.stringify(result));
    writeFileSync(`${SHOTS}/look-perf.json`, JSON.stringify(result, null, 2));
    expect(ms.new.length).toBeGreaterThan(0);
  });
});

test('the new look: its ambient occlusion on its own, by the market stalls @gpu', async ({ page }) => {
  const errors = await open(page, 'new', '&lookdebug=ao');
  const s = SCENES.find((x) => x.id === 'stalls-closeup')!;
  await setHour(page, s.hour);
  await page.evaluate(([x, z, f]) => (window as any).__game.teleport(x, z, f), [s.x, s.z, s.facing] as const);
  await page.evaluate((c) => (window as any).__game.setCamera(c), s.camera);
  await page.evaluate(() => (window as any).__game.advance(40));
  await page.screenshot({ path: `${SHOTS}/look-ao-stalls.png` });
  expect(errors).toEqual([]);
});
