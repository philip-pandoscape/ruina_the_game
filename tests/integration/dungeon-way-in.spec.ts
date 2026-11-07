import { expect, test, type Page } from '@playwright/test';
import type { Command } from '../../src/engine/life';
import { floorAt } from '../../src/engine/world/dungeons';
import { arrivalOf, DUNGEONS, EMBERHOLM } from '../../src/engine/zone';
import type { LifePress } from '../../src/ui/life/lifeUI';
import { gameReady } from '../support/game';

// The way into Goblin's Dread (content/instances/goblinsDread.json). A spring beside the Windspire's
// launch deck spills down a slot cut in its face (crates/engine/src/open/generate.rs, falls), and behind the
// falling water a ledge under a hood of rock holds the goblins' landing stage and the portal: you get
// there by gliding into the falls. Offline (?test) the browser takes you through the portal
// itself (src/app/dungeonVisit.ts); online the server takes you, with your party, into your copy.
// Inside, the dungeon is a space of its own: placed round its own origin, over nothing.

const SHOTS = 'screenshots';

interface Falls {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  lip: number;
  shelf: { s0: number; s1: number; top: number };
  roof: { s0: number; s1: number; top: number };
  landing: { s0: number; s1: number; half: number; top: number };
}

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?test');
  await gameReady(page, 60_000);
  await page.evaluate(() => window.__game.reset());
  return errors;
}

const g = (page: Page) => ({
  advance: (frames: number, a: Record<string, unknown> = {}) => page.evaluate(([n, x]) => window.__game.advance(n, x), [frames, a] as const),
  player: () => page.evaluate(() => window.__game.state().player),
  dungeon: () => page.evaluate(() => window.__game.dungeon()),
  falls: () => page.evaluate(() => window.__game.falls()[0] as Falls),
  cmd: (c: Command) => page.evaluate((x) => window.__game.lifeCommand(x), c),
  teleport: (x: number, z: number, facing = 0) => page.evaluate(([a, b, c]) => window.__game.teleport(a, b, c), [x, z, facing] as const),
  press: (k: LifePress) => page.evaluate((x) => window.__game.pressLife(x), k),
});

test("through the portal into a copy of Goblin's Dread and back out, nothing of it left solid", async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  const door = EMBERHOLM.doors![0];
  // On the stage in front of the portal, facing it.
  const facing = door.outside.facing + Math.PI;
  await w.teleport(door.portal.x + (door.outside.x - door.portal.x) * 0.6, door.portal.z + (door.outside.z - door.portal.z) * 0.6, facing);
  await w.advance(2);
  expect((await w.dungeon()).focus?.action).toBe('enterDungeon');
  await w.press('interact');
  await w.advance(10);
  let d = await w.dungeon();
  expect(d.inside).toBe('goblinsDread');
  expect(d.drawn).toBe('goblinsDread');
  expect(d.solid).toEqual({ goblinsDread: true });
  let p = await w.player();
  // On the inner landing stage: the dungeon's way in, in its own frame.
  const def = DUNGEONS.goblinsDread!;
  const arrive = arrivalOf(def);
  const floor = floorAt(def, arrive.x, arrive.z)!;
  expect(p.pos.x).toBeCloseTo(arrive.x, 1);
  expect(p.pos.z).toBeCloseTo(arrive.z, 1);
  expect(p.pos.y).toBeCloseTo(floor, 1);
  expect(p.grounded).toBe(true);
  // No island map in here.
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('hud-minimap')!).display)).toBe('none');
  await page.screenshot({ path: `${SHOTS}/dungeon-02-inside.png` });
  // Off its floor there's nothing at all (none of the island is here): down, and back at the way in.
  await w.teleport(arrive.x + 40, arrive.z, arrive.facing);
  await w.advance(2);
  p = await w.player();
  expect(p.pos.x).toBeCloseTo(arrive.x, 1);
  expect(p.pos.z).toBeCloseTo(arrive.z, 1);
  expect(p.pos.y).toBeCloseTo(floor, 1);
  // Walk back to the falls and out through them.
  for (let i = 0; i < 60 && (await w.dungeon()).focus?.action !== 'leaveDungeon'; i++) await w.advance(3, { moveZ: -1 });
  d = await w.dungeon();
  expect(d.focus).toEqual({ action: 'leaveDungeon', label: "Leave Goblin's Dread", ok: true });
  await w.press('interact');
  await w.advance(10);
  d = await w.dungeon();
  expect(d.inside).toBeNull();
  expect(d.drawn).toBeNull();
  expect(d.solid).toEqual({ goblinsDread: false });
  p = await w.player();
  // Out on the stage behind the falls, facing out.
  expect(p.pos.x).toBeCloseTo(door.outside.x, 1);
  expect(p.pos.z).toBeCloseTo(door.outside.z, 1);
  expect(p.pos.y).toBeGreaterThan(door.portal.y - 0.1);
  expect(p.pos.y).toBeLessThan(door.portal.y + 1);
  await page.screenshot({ path: `${SHOTS}/dungeon-03-back-out.png` });
  expect(errors).toEqual([]);
});
