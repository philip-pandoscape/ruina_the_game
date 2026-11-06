import { expect } from 'vitest';
import { test, type Page } from '../../support/headless';
import type { Command } from '../../../src/engine/island';
import type { LifePress } from '../../../src/ui/life/lifeUI';
import { gameReady } from '../../support/headless';

// The way into Goblin's Dread (content/instances/goblinsDread.json). A spring beside the Windspire's
// launch deck spills down a slot cut in its face (crates/engine/src/open/generate.rs, falls), and behind the
// falling water a ledge under a hood of rock holds the goblins' landing stage and the portal: you get
// there by gliding into the falls. Offline (?world&test) the browser takes you through the portal
// itself (src/app/dungeonVisit.ts); online the server takes you, with your party, into your copy.

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
  await page.goto('/?world&test');
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

/** Out along the falls' bearing (s) and across it (t), from the mountain's middle. */
function frame(f: Falls) {
  return {
    at: (s: number, t: number) => ({ x: f.cx + f.ux * s + f.vx * t, z: f.cz + f.uz * s + f.vz * t }),
    st: (x: number, z: number) => ({ s: (x - f.cx) * f.ux + (z - f.cz) * f.uz, t: (x - f.cx) * f.vx + (z - f.cz) * f.vz }),
    out: Math.atan2(f.ux, f.uz),
  };
}

test("a glider off the Windspire's deck flies into the falls and lands behind them on the goblins' stage, by the portal", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await open(page);
  const w = g(page);
  await w.cmd({ t: 'grant', item: 'glider.wayfarer', n: 1 });
  await w.advance(1);
  await w.cmd({ t: 'use', item: 'glider.wayfarer' });
  const f = await w.falls();
  const fr = frame(f);
  // From the corner of the launch deck, well clear of the slot, out over the edge the way the falls face.
  const start = fr.at(19.9, -9.9);
  await w.teleport(start.x, start.z, fr.out);
  // Run to the edge, then jump, jump again and open the wing over the drop.
  const run = { moveX: Math.sin(fr.out), moveZ: Math.cos(fr.out) };
  for (let i = 0; i < 40; i++) {
    const p = await w.player();
    if (fr.st(p.pos.x, p.pos.z).s > f.lip + 0.8) break;
    await w.advance(4, run);
  }
  for (let i = 0; i < 6 && (await w.player()).mode !== 'glide'; i++) {
    await w.advance(1, { moveX: Math.sin(fr.out), moveZ: Math.cos(fr.out), jumpPressed: true, jumpHeld: true });
    await w.advance(8, { moveX: Math.sin(fr.out), moveZ: Math.cos(fr.out) });
  }
  expect((await w.player()).mode).toBe('glide');
  // Out in front of the slot, round, and back up it at the ledge's height, through the falling water.
  const route = [
    { ...fr.at(100, -9), y: 106 },
    { ...fr.at(62, 0), y: 92 },
    { ...fr.at(37, 0), y: 87.6 },
    { ...fr.at(30.5, 0), y: 85.8 },
  ];
  // Flies the route from leg `leg`, three frames a decision; stops on the ground, or (`near`) once
  // the leg into the falls is that close.
  const fly = (leg: number, near: number) =>
    page.evaluate(
      ({ route, leg, near, f }) => {
        const game = window.__game;
        for (let frames = 0; frames < 60 * 60; frames += 3) {
          const p = game.state().player;
          if (p.mode !== 'glide') return { leg, frames, landed: true };
          const target = route[leg];
          const dx = target.x - p.pos.x;
          const dz = target.z - p.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 5 && leg < route.length - 1) {
            leg++;
            continue;
          }
          if (leg === 2 && dist < near) return { leg, frames, landed: false };
          // How steeply it has to come down to be there: dive if steeper than it glides, flare if shallower.
          const need = (p.pos.y - target.y) / Math.max(1, dist);
          const dive = need > 0.24;
          const flare = need < 0.1 && !dive;
          // Out over the island, straight for the next point; up the slot, along it, back to its middle.
          let mx = dx / Math.max(dist, 1e-6);
          let mz = dz / Math.max(dist, 1e-6);
          if (leg >= 2) {
            const t = (p.pos.x - f.cx) * f.vx + (p.pos.z - f.cz) * f.vz;
            const k = Math.max(-0.5, Math.min(0.5, t * 0.3));
            mx = -f.ux - f.vx * k;
            mz = -f.uz - f.vz * k;
          }
          game.advance(3, { moveX: mx, moveZ: mz, sprintHeld: dive, crouchHeld: flare }, false);
        }
        return { leg, frames: 3600, landed: false };
      },
      { route, leg, near, f },
    );
  const approach = await fly(0, 30);
  expect(approach.landed).toBe(false);
  await page.evaluate(() => window.__game.render());
  await page.screenshot({ path: `${SHOTS}/dungeon-00-gliding-in.png` });
  const flown = await fly(approach.leg, 0);
  // Down onto the stage, or into the back wall and down off it: either way, a moment to settle.
  await w.advance(40);
  const p = await w.player();
  const here = fr.st(p.pos.x, p.pos.z);
  console.log('glide in', { ...flown, s: +here.s.toFixed(2), t: +here.t.toFixed(2), y: +p.pos.y.toFixed(2), mode: p.mode });
  // Down on the ledge behind the falls: on the stage or the rock beside it, out of the air.
  expect(p.mode).toBe('normal');
  expect(p.grounded).toBe(true);
  expect(here.s).toBeGreaterThan(f.shelf.s0);
  expect(here.s).toBeLessThan(f.landing.s1 + 0.2);
  expect(Math.abs(here.t)).toBeLessThan(4.5);
  expect(p.pos.y).toBeGreaterThan(f.shelf.top - 0.1);
  expect(p.pos.y).toBeLessThan(f.landing.top + 0.3);
  // To the portal, at the back wall.
  const back = { moveX: -Math.sin(fr.out), moveZ: -Math.cos(fr.out) };
  for (let i = 0; i < 40 && (await w.dungeon()).focus?.action !== 'enterDungeon'; i++) await w.advance(3, back);
  await w.advance(1);
  const at = await w.dungeon();
  expect(at.focus).toEqual({ action: 'enterDungeon', label: "Enter Goblin's Dread", ok: true });
  await page.evaluate(() => window.__game.setCamera({ yaw: Math.atan2(-0.342, 0.94), pitch: 0.15, distance: 6 }));
  await w.advance(2);
  await page.screenshot({ path: `${SHOTS}/dungeon-01-the-portal.png` });
  expect(errors).toEqual([]);
});

test('anyone dropping off the summit over the falls lands on the hood of rock, not on the ledge behind them', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  const f = await w.falls();
  const fr = frame(f);
  const top = fr.at(f.lip - 2.5, 0);
  await w.teleport(top.x, top.z, fr.out);
  // Step off the lip, then let go: down you go.
  for (let i = 0; i < 30; i++) {
    const p = await w.player();
    if (!p.grounded) break;
    await w.advance(3, { moveX: Math.sin(fr.out) * 0.6, moveZ: Math.cos(fr.out) * 0.6 });
  }
  await w.advance(150);
  const p = await w.player();
  const here = fr.st(p.pos.x, p.pos.z);
  console.log('dropped', { s: +here.s.toFixed(2), y: +p.pos.y.toFixed(2), grounded: p.grounded });
  expect(p.grounded).toBe(true);
  expect(p.pos.y).toBeCloseTo(f.roof.top, 0);
  expect((await w.dungeon()).focus?.action).not.toBe('enterDungeon');
  expect(errors).toEqual([]);
});
