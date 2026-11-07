import '../support/engineSetup';
import { expect, test, type Page } from '@playwright/test';
import { SAVE_KEY } from '../../src/app/save';
import { type Command, newLifeState, sailEfficiency } from '../../src/engine/life';
import { EMBERHOLM } from '../../src/engine/zone';
import { skillsFrom } from '../../src/content/skills';
import { LABOR } from '../../src/content/trade';
import { abilityIndex, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIDE_SKILL, weaponIndex } from '../../src/content/tuning';
import { gameReady } from '../support/game';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The open world (Emberholm): terrain, swimming, gliding, farming, pack running, vehicles, mounts,
// housing, quests and saving. Like the other specs these drive the real game through
// window.__game (src/main.ts), paused, a frame at a time. Screenshots land in screenshots/.

const SHOTS = 'screenshots';

type Actions = Partial<{
  attackPressed: boolean;
  moveX: number;
  moveZ: number;
  stickX: number;
  stickY: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  sprintHeld: boolean;
  crouchHeld: boolean;
}>;

async function open(page: Page, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?test${extra}`);
  await gameReady(page, 60_000);
  await page.evaluate(() => window.__game.reset());
  return errors;
}

const g = (page: Page) => ({
  advance: (frames: number, a: Actions = {}) => page.evaluate(([n, x]) => window.__game.advance(n, x), [frames, a] as const),
  player: () => page.evaluate(() => window.__game.state().player),
  life: () => page.evaluate(() => window.__game.life()),
  zone: () => page.evaluate(() => window.__game.zone()),
  cmd: (c: Command) => page.evaluate((x) => window.__game.lifeCommand(x), c),
  teleport: (x: number, z: number, facing = 0) => page.evaluate(([a, b, c]) => window.__game.teleport(a, b, c), [x, z, facing] as const),
  ground: (x: number, z: number) => page.evaluate(([a, b]) => window.__game.ground(a, b), [x, z] as const),
});

/** Grants items through the dev command and lets a step run so they land in the bag. */
async function grant(page: Page, items: Array<[string, number]>, extra: Record<string, number> = {}): Promise<void> {
  const w = g(page);
  for (const [item, n] of items) await w.cmd({ t: 'grant', item, n });
  if (Object.keys(extra).length) await w.cmd({ t: 'grant', ...extra });
  await w.advance(1);
}

/** Stands 1.6 m in front of an NPC, facing them. */
async function faceNpc(page: Page, id: string): Promise<void> {
  const w = g(page);
  const z = await w.zone();
  const n = z.npcs.find((x: { id: string }) => x.id === id);
  await w.teleport(n.x + Math.sin(n.facing) * 1.6, n.z + Math.cos(n.facing) * 1.6, n.facing + Math.PI);
  await w.advance(2);
}

test('the open world loads: ground, sea, townsfolk and HUD, without errors', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await page.evaluate(() => window.__game.setCamera({ yaw: 0.25, pitch: 0.28, distance: 9 }));
  await w.advance(30);
  await page.screenshot({ path: `${SHOTS}/world-01-lanternwick.png` });
  const z = await w.zone();
  expect(z.places.length).toBeGreaterThan(8);
  expect(z.npcs.length).toBeGreaterThanOrEqual(12);
  const p = await w.player();
  // Spawn is on the village square, not under it or floating over it.
  expect(Math.abs(p.pos.y - (await w.ground(p.pos.x, p.pos.z)))).toBeLessThan(0.05);
  // The HUD is up and the first quest started by itself.
  // Health, MP, stamina, labor and money sit beside your portrait; the minimap and the quest scroll on the right.
  await expect(page.locator('#hud-vitals')).toContainText('1000');
  await expect(page.locator('#hud-vitals .hud-bar')).toHaveCount(4);
  await expect(page.locator('#hud-vitals .v-mp')).toContainText('100 / 100');
  await expect(page.locator('#hud-vitals .v-st')).toContainText('100 / 100');
  await expect(page.locator('#hud-minimap canvas')).toBeVisible();
  await expect(page.locator('#lui-quests')).toContainText('Landfall');
  const perf = await page.evaluate(() => window.__game.perf());
  console.log('world render', { drawCalls: perf.drawCalls, triangles: perf.triangles });
  expect(perf.drawCalls).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('swimming: wade into the sea and you swim; come back out and you walk', async ({ page }) => {
  await open(page);
  const w = g(page);
  // Sunscale Strand, facing out into the bay.
  const z = await w.zone();
  const strand = z.places.find((p: { id: string }) => p.id === 'strand');
  const bay = { x: -330, z: -330 };
  const dx = bay.x - strand.x;
  const dz = bay.z - strand.z;
  const l = Math.hypot(dx, dz);
  await w.teleport(strand.x, strand.z, Math.atan2(dx, dz));
  await w.advance(2);
  let swam = false;
  for (let i = 0; i < 60 && !swam; i++) {
    await w.advance(10, { moveX: dx / l, moveZ: dz / l });
    swam = (await w.player()).mode === 'swim';
  }
  expect(swam).toBe(true);
  const p = await w.player();
  expect(p.pos.y).toBeLessThan(0);
  expect(p.pos.y).toBeGreaterThan(-1.6);
  expect(await page.evaluate(() => window.__game.heroWeapon()), 'the weapon, swimming').toBe('hidden');
  await page.screenshot({ path: `${SHOTS}/world-02-swimming.png` });
  // Turn round and swim back to shore.
  let walking = false;
  for (let i = 0; i < 90 && !walking; i++) {
    await w.advance(10, { moveX: -dx / l, moveZ: -dz / l });
    walking = (await w.player()).mode === 'normal';
  }
  expect(walking).toBe(true);
});

test('glider: rising air at the foot of the Windspire lifts you; C flares it and lands you crouched; a trade pack keeps it shut', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [
    ['glider.wayfarer', 1],
    ['sunroot', 6],
    ['barley', 4],
  ]);
  await w.cmd({ t: 'use', item: 'glider.wayfarer' });
  const z = await w.zone();
  const u = z.updrafts[0];
  // Jump, double jump and open the wing right in the column.
  await w.teleport(u.x, u.z, 0);
  await w.advance(2);
  await w.advance(1, { jumpPressed: true, jumpHeld: true });
  await w.advance(12, { jumpHeld: true });
  await w.advance(1, { jumpPressed: true, jumpHeld: true });
  await w.advance(16, { jumpHeld: true }); // near the top of the double jump
  await w.advance(1, { jumpPressed: true, jumpHeld: true });
  await w.advance(4);
  let p = await w.player();
  expect(p.mode).toBe('glide');
  const y0 = p.pos.y;
  // Flare to hang in the rising air.
  let top = y0;
  for (let i = 0; i < 10; i++) {
    await w.advance(12, { crouchHeld: true });
    top = Math.max(top, (await w.player()).pos.y);
  }
  console.log('updraft climb', (top - y0).toFixed(1));
  expect(top).toBeGreaterThan(y0 + 3);

  // Out on open grass, C itself flares the wing, and pressed in the air it leaves no slide waiting
  // for the landing: you come down crouched.
  await w.teleport(-150, -222, 0);
  await w.advance(2);
  await w.advance(1, { jumpPressed: true, jumpHeld: true });
  await w.advance(12, { jumpHeld: true });
  await w.advance(1, { jumpPressed: true, jumpHeld: true });
  await w.advance(16, { jumpHeld: true });
  await w.advance(1, { jumpPressed: true, jumpHeld: true });
  await w.advance(30);
  p = await w.player();
  expect(p.mode).toBe('glide');
  // Still picking up speed toward its cruise; flaring, it sheds it instead.
  const opened = p.airspeed;
  const live = (n: number, drawn = true) => page.evaluate(([k, d]) => window.__game.advanceLive(k, d), [n, drawn] as const);
  const slides = () => page.evaluate((id) => window.__game.events().filter((e: any) => e.type === 'action' && e.id === id).length, SLIDE_SKILL);
  const before = await slides();
  await page.keyboard.down('KeyC');
  await live(45, false);
  p = await w.player();
  expect(p.mode).toBe('glide');
  expect(p.airspeed).toBeLessThan(opened - 1);
  // Down to the ground in the page, drawn once there.
  await page.evaluate(() => {
    const game = window.__game;
    for (let i = 0; i < 20 && !game.state().player.grounded; i++) game.advanceLive(30, false);
  });
  await live(6);
  p = await w.player();
  expect([p.mode, p.grounded, p.crouching, (await slides()) - before]).toEqual(['normal', true, true, 0]);
  await page.keyboard.up('KeyC');

  // With a pack on your back the glider will not open.
  const wb = z.workbenches[0];
  await w.teleport(wb.x, wb.z + 2, Math.PI);
  await w.cmd({ t: 'craft', recipe: 'pack.harvestCrate' });
  await w.advance(2);
  expect((await w.player()).pack).toBeGreaterThan(0);
  const spire = z.places.find((pl: { id: string }) => pl.id === 'windspire');
  await w.teleport(spire.x, spire.z - 5, Math.PI);
  await w.advance(25, { moveZ: -1 });
  for (let i = 0; i < 4; i++) {
    await w.advance(1, { moveZ: -1, jumpPressed: true, jumpHeld: true });
    await w.advance(10, { moveZ: -1 });
  }
  expect((await w.player()).mode).not.toBe('glide');
});

test('farming: ground circles and the shadow under you lie on top of a plot, its furrows and its edges, turned on a slope', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await grant(page, [['scarecrow', 1]]);
  // A plot turned 30 degrees, on ground that rises well over a metre across it.
  await w.teleport(-150, -300, Math.PI / 6);
  await w.cmd({ t: 'use', item: 'scarecrow' });
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  const sc = (await w.life()).scarecrows[0];
  expect(sc.rot).toBeCloseTo(Math.PI / 6);
  const at = (lx: number, lz: number) => ({ x: sc.x + lx * Math.cos(sc.rot) + lz * Math.sin(sc.rot), z: sc.z - lx * Math.sin(sc.rot) + lz * Math.cos(sc.rot) });
  // A Meteor aimed at the plot's near corner: its warning lies over soil, furrow ends and grass.
  const mage = {
    skills: skillsFrom('staff', 'meteor'),
    weapon: weaponIndex('staff'),
    abilities: [abilityIndex('meteor'), ...new Array(HOTBAR_SLOTS - 1).fill(NO_ABILITY)],
    movement: emptyMovement(),
  };
  expect(await page.evaluate((b) => window.__game.setBuild(b), mage)).toBe(true);
  const corner = at(4, -4);
  const p = await w.player();
  await page.evaluate(([dx, dz]) => window.__game.advance(1, { abilitySlot: 1, aimX: dx, aimZ: dz }), [corner.x - p.pos.x, corner.z - p.pos.z] as const);
  await w.advance(20);
  expect((await w.player()).mode).toBe('cast');
  const seen = await page.evaluate(
    ([cx, cz, r]) => {
      const g = window.__game;
      g.render();
      const out = { samples: 0, soil: 0, furrow: 0, grass: 0, missing: 0, under: [] as string[] };
      for (let x = cx - r; x <= cx + r; x += 0.1) {
        for (let z = cz - r; z <= cz + r; z += 0.1) {
          if (Math.hypot(x - cx, z - cz) > r * 0.92) continue;
          out.samples++;
          const circle = g.circleHeight(x, z);
          const farm = g.farmGround(x, z);
          const ground = g.ground(x, z);
          if (circle === null) {
            out.missing++;
            continue;
          }
          if (farm === null) out.grass++;
          else if (farm - ground > 0.08) out.furrow++;
          else out.soil++;
          const top = Math.max(ground, farm ?? -Infinity);
          if (circle < top + 0.005) out.under.push(`(${x.toFixed(1)}, ${z.toFixed(1)}): circle ${circle.toFixed(3)}, ground drawn at ${top.toFixed(3)}`);
        }
      }
      return out;
    },
    [corner.x, corner.z, 3.5] as const,
  );
  console.log('circle over the plot', { ...seen, under: seen.under.length });
  expect(seen.missing, 'the warning is drawn all the way across').toBe(0);
  expect(seen.soil).toBeGreaterThan(100);
  expect(seen.furrow).toBeGreaterThan(20);
  expect(seen.grass).toBeGreaterThan(100);
  expect(seen.under.slice(0, 5)).toEqual([]);
  await page.evaluate(() => window.__game.setCamera({ yaw: Math.PI / 6 + 0.5, pitch: 0.75, distance: 11 }));
  await w.advance(1);
  await page.screenshot({ path: `${SHOTS}/world-05-farm-warning.png` });
  await w.advance(90);

  // Standing on a furrow, the shadow under you lies on it rather than under the soil.
  const row = at(-1, -1);
  await w.teleport(row.x, row.z, 0);
  await w.advance(2);
  const shadow = await page.evaluate(() => {
    const g = window.__game;
    const q = g.state().player.pos;
    return { shadow: g.shadowHeight(), farm: g.farmGround(q.x, q.z), ground: g.ground(q.x, q.z) };
  });
  expect(shadow.farm! - shadow.ground).toBeGreaterThan(0.08);
  expect(shadow.shadow).toBeGreaterThan(shadow.farm!);
  expect(errors).toEqual([]);
});

test('pack running: craft a pack, carry it slowly, sell it, and watch demand fall and recover', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [
    ['sunroot', 12],
    ['barley', 8],
  ]);
  const z = await w.zone();
  // On foot, unburdened, across the square.
  const run = async () => {
    await w.teleport(-20, -246, -Math.PI / 2);
    await w.advance(30, { moveX: -1 });
    const a = (await w.player()).pos.x;
    await w.advance(60, { moveX: -1 });
    return Math.abs((await w.player()).pos.x - a);
  };
  const free = await run();
  const wb = z.workbenches[0];
  await w.teleport(wb.x, wb.z + 2, Math.PI);
  await w.advance(1);
  expect((await w.life()).focus?.action).toBe('craft');
  await w.cmd({ t: 'craft', recipe: 'pack.harvestCrate' });
  await w.advance(2);
  const carrier = await w.player();
  expect(carrier.pack).toBeGreaterThan(0);
  // On your back, not your chest: the crate's bulk sits behind you.
  const [worn] = await page.evaluate(() => window.__game.sceneObjects('pack:'));
  const ahead = (worn.centre.x - carrier.pos.x) * Math.sin(carrier.facing) + (worn.centre.z - carrier.pos.z) * Math.cos(carrier.facing);
  expect(ahead).toBeLessThan(-0.25);
  const loaded = await run();
  console.log('m/s free vs carrying', free, loaded);
  expect(loaded).toBeLessThan(free * 0.65);
  // Sell at Westwatch.
  await faceNpc(page, 'dunmore');
  const f = (await w.life()).focus;
  expect(f.action).toBe('sell');
  const coins = (await w.life()).coins;
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  const l = await w.life();
  expect(l.coins).toBeGreaterThan(coins + 250);
  expect(l.seals).toBe(1);
  const d1 = l.demand['westwatch:harvestCrate'];
  expect(d1).toBeLessThan(1.1);
  await w.cmd({ t: 'warp', seconds: 300 });
  await w.advance(1);
  expect((await w.life()).demand['westwatch:harvestCrate']).toBeGreaterThan(d1);
  // Gullrock, over the sea, pays more for the same crate.
  await w.teleport(wb.x, wb.z + 2, Math.PI);
  await w.cmd({ t: 'craft', recipe: 'pack.harvestCrate' });
  await w.advance(2);
  await faceNpc(page, 'pell');
  const sea = (await w.life()).focus;
  console.log('gullrock offer', sea.detail);
  const c2 = (await w.life()).coins;
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.life()).coins - c2).toBeGreaterThan(400);
});

test('vehicles: summon a farm cart, load two packs, drive, unload', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [
    ['deed.farmCart', 1],
    ['sunroot', 12],
    ['barley', 8],
  ]);
  const z = await w.zone();
  const wb = z.workbenches[0];
  await w.teleport(wb.x - 6, wb.z + 6, 0);
  await w.cmd({ t: 'summon', item: 'deed.farmCart' });
  await w.advance(2);
  let cart = (await w.life()).vehicles[0];
  expect(cart?.def).toBe('farmCart');
  const weapon = () => page.evaluate(() => window.__game.heroWeapon());
  // Two crates, each carried from the bench to the cart's bed (behind it).
  for (let i = 0; i < 2; i++) {
    await w.teleport(wb.x, wb.z + 2, Math.PI);
    await w.cmd({ t: 'craft', recipe: 'pack.harvestCrate' });
    await w.advance(2);
    // A pack on the back: hands on its straps, the weapon out of sight.
    expect(await weapon()).toBe('hidden');
    cart = (await w.life()).vehicles[0];
    const bx = cart.x - Math.sin(cart.heading) * 2.6;
    const bz = cart.z - Math.cos(cart.heading) * 2.6;
    await w.teleport(bx, bz, cart.heading);
    await w.advance(2);
    expect((await w.life()).focus?.action).toBe('load');
    await w.cmd({ t: 'interact' });
    await w.advance(2);
  }
  cart = (await w.life()).vehicles[0];
  expect(cart.cargo.filter((c: number) => c !== 0).length).toBe(2);
  // Get in from the side, level with the seat, and drive.
  await w.teleport(
    cart.x + Math.cos(cart.heading) * 1.9 + Math.sin(cart.heading) * 0.9,
    cart.z - Math.sin(cart.heading) * 1.9 + Math.cos(cart.heading) * 0.9,
    cart.heading,
  );
  await w.advance(2);
  expect((await w.life()).focus?.action).toBe('board');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  const x0 = cart.x;
  const z0 = cart.z;
  await w.advance(150, { stickY: 1 });
  await page.screenshot({ path: `${SHOTS}/world-05-farm-cart.png` });
  // At the wheel the weapon is out of sight, not across the lap.
  expect(await weapon()).toBe('hidden');
  cart = (await w.life()).vehicles[0];
  expect(Math.hypot(cart.x - x0, cart.z - z0)).toBeGreaterThan(8);
  // Packs went along for the ride.
  expect((await w.life()).packs.filter((p: { at: string }) => p.at === 'cargo').length).toBe(2);
  await w.cmd({ t: 'exit' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('normal');
  // Back on foot, it hangs at the hip again.
  expect(await weapon()).toBe('away');
  cart = (await w.life()).vehicles[0];
  await w.teleport(cart.x - Math.sin(cart.heading) * 2.6, cart.z - Math.cos(cart.heading) * 2.6, cart.heading);
  await w.advance(2);
  expect((await w.life()).focus?.action).toBe('unload');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.player()).pack).toBeGreaterThan(0);
});

test('boats: a rowboat at the docks, and a sloop runs faster with the wind behind it', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [
    ['deed.rowboat', 1],
    ['deed.sloop', 1],
  ]);
  await w.teleport(-10, -334, Math.PI);
  await w.cmd({ t: 'summon', item: 'deed.rowboat' });
  await w.advance(2);
  const boat = (await w.life()).vehicles[0];
  expect(boat.def).toBe('rowboat');
  expect(boat.y).toBe(0);
  await w.cmd({ t: 'recall', vehicle: boat.id });
  await w.advance(1);
  await w.cmd({ t: 'summon', item: 'deed.sloop' });
  await w.advance(2);
  const sloop = (await w.life()).vehicles[0];
  expect(sloop.def).toBe('sloop');
  await w.teleport(sloop.x + Math.cos(sloop.heading) * 2.4, sloop.z - Math.sin(sloop.heading) * 2.4, sloop.heading);
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  expect(await page.evaluate(() => window.__game.heroWeapon()), 'the weapon at the helm').toBe('hidden');
  // Raise the sail and stand out to sea.
  await w.advance(420, { stickY: 1 });
  const v = (await w.life()).vehicles[0];
  await page.screenshot({ path: `${SHOTS}/world-06-sloop.png` });
  console.log('sloop m/s after 7 s', v.speed.toFixed(1), 'sail', v.sail.toFixed(2));
  expect(v.sail).toBeGreaterThan(0.95);
  expect(v.speed).toBeGreaterThan(4);
  // Wind behind you is worth far more than wind in your face.
  expect(sailEfficiency(0)).toBeGreaterThan(sailEfficiency(Math.PI) * 3);
  expect(sailEfficiency(Math.PI / 2)).toBeGreaterThan(sailEfficiency(Math.PI));
});

test('mounts: the donkey carries a pack, the horse will not', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [
    ['whistle.horse', 1],
    ['sunroot', 6],
    ['barley', 4],
  ]);
  const z = await w.zone();
  const wb = z.workbenches[0];
  await w.teleport(wb.x, wb.z + 2, Math.PI);
  await w.cmd({ t: 'craft', recipe: 'pack.harvestCrate' });
  await w.advance(2);
  await w.teleport(0, -200, 0);
  await w.cmd({ t: 'mount' });
  await w.advance(2);
  expect((await w.player()).mode).not.toBe('ride');
  await grant(page, [['whistle.donkey', 1]]);
  await w.cmd({ t: 'mount' });
  await w.advance(2);
  const p = await w.player();
  expect(p.mode).toBe('ride');
  expect(p.pack).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__game.heroWeapon()), 'the weapon in the saddle').toBe('hidden');
  const l = await w.life();
  expect(l.vehicles.find((v: { ridden: boolean }) => v.ridden).def).toBe('donkey');
  const x0 = p.pos.x;
  const z0 = p.pos.z;
  await w.advance(120, { moveZ: 1, sprintHeld: true });
  const q = await w.player();
  const speed = Math.hypot(q.pos.x - x0, q.pos.z - z0) / 2;
  console.log('donkey with pack m/s', speed.toFixed(2));
  // Faster than walking with the pack (about 4 m/s), no faster than its pack pace.
  expect(speed).toBeGreaterThan(4.5);
  expect(speed).toBeLessThan(7.6);
});

test('quests: the starter chain advances from what you do', async ({ page }) => {
  await open(page);
  const w = g(page);
  expect((await w.life()).quests.active[0].id).toBe('landfall');
  await faceNpc(page, 'hollis');
  expect((await w.life()).focus?.action).toBe('talk');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await expect(page.locator('.lui-card')).toContainText('Reeve Hollis');
  await page.screenshot({ path: `${SHOTS}/world-08-dialog.png` });
  await w.cmd({ t: 'complete', quest: 'landfall' });
  await w.advance(2);
  let l = await w.life();
  expect(l.quests.done).toContain('landfall');
  expect(l.bag.some((s: { item: string }) => s.item === 'scarecrow')).toBe(true);
  await w.cmd({ t: 'accept', quest: 'patch' });
  await w.advance(1);
  await page.evaluate(() => window.__game.closeLifePanel());
  await w.teleport(-150, -222, 0);
  await w.cmd({ t: 'use', item: 'scarecrow' });
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  l = await w.life();
  const q = l.quests.active.find((x: { id: string }) => x.id === 'patch');
  expect(q.step).toBe(1);
});

test('stone and timber: before the house, the quests lead you to the outcrops, the deadfall and the benches', async ({ page }) => {
  // A life that has done everything before the house, kept in this browser for ?load.
  const quill = EMBERHOLM.npcs.find((n) => n.id === 'quill')!;
  const state = newLifeState({ coins: 200, labor: LABOR.start, seed: EMBERHOLM.seed });
  state.quests = { active: [], done: ['landfall', 'patch', 'wings', 'firstFlight', 'harvest', 'packwright', 'westward'] };
  state.labor = 1000;
  const saved = { savedAt: Date.now(), state, player: { x: quill.x - 1.6, y: 0, z: quill.z, facing: Math.PI / 2 } };
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SAVE_KEY, JSON.stringify(saved)] as const);
  const errors = await open(page, '&load');
  const w = g(page);
  const z = await w.zone();
  // Moving about without drawing (CI draws in software): only the end is drawn.
  const quiet = (frames: number) => page.evaluate((n) => window.__game.advance(n, {}, false), frames);
  const goTo = async (x: number, zz: number, facing: number) => {
    await page.evaluate(([a, b, c]) => window.__game.teleport(a, b, c, false), [x, zz, facing] as const);
    await quiet(2);
  };
  const toNpc = (id: string) => {
    const n = z.npcs.find((x: { id: string }) => x.id === id);
    return goTo(n.x + Math.sin(n.facing) * 1.6, n.z + Math.cos(n.facing) * 1.6, n.facing + Math.PI);
  };
  const press = async () => {
    await w.cmd({ t: 'interact' });
    await quiet(2);
  };
  const close = () => page.evaluate(() => window.__game.closeLifePanel());
  const goal = () => page.evaluate(() => window.__game.questGoal());
  const progress = async (id: string) => (await w.life()).quests.active.find((q: { id: string }) => q.id === id);
  const count = async (item: string) =>
    ((await w.life()).bag as Array<{ item: string; n: number }>).filter((s) => s.item === item).reduce((n, s) => n + s.n, 0);
  const card = page.locator('.lui-card');

  // Quill won't grant land before you know what a house is made of.
  await toNpc('quill');
  await press();
  await expect(card.locator('[data-act="quest"][data-arg="home"]')).toHaveCount(0);
  await card.locator('[data-act="quest"][data-arg="stonecutting"]').click();
  await expect(card).toContainText('you quarry the stone and cut the blocks yourself');
  await card.locator('[data-act="accept"]').click();
  await quiet(1);
  await close();
  expect((await goal()).label).toBe('Brenna Stoneheart');

  // Brenna at the quarry, then the nearest outcrop: each swing counts the stone it gives.
  await toNpc('brenna');
  await press();
  await close();
  expect((await goal()).label).toBe('Stone Outcrop');
  for (const nd of z.nodes.filter((n: { kind: string }) => n.kind === 'stoneNode')) {
    if ((await progress('stonecutting')).step > 1) break;
    await goTo(nd.x, nd.z + 2, Math.PI);
    const f = (await w.life()).focus;
    expect([f.label, f.detail]).toEqual(['Quarry Stone', '8 Labor · 3-5 Stone']);
    await press();
    const q = await progress('stonecutting');
    if (q.step === 1) expect(q.counts[0]).toBe(await count('stone'));
  }
  expect((await progress('stonecutting')).step).toBe(2);
  // The table says what it makes; its window says where stone comes from when you're short.
  expect((await goal()).label).toBe("Stonecutter's Table");
  const cutter = z.workbenches.find((b: { id: string }) => b.id === 'stonecutter');
  await goTo(cutter.x, cutter.z + 1.5, Math.PI);
  expect((await w.life()).focus.detail).toBe('Stone Block · Iron Fittings Crate');
  await press();
  await expect(card).toContainText("Six make an Iron Fittings Crate at the Stonecutter's Table");
  await card.locator('[data-act="make"][data-arg="pack.stoneBlock"]').click();
  await quiet(2);
  // Packing it closes the window (a moment later).
  await expect.poll(() => page.evaluate(() => window.__game.lifePanel())).toBeNull();
  expect((await progress('stonecutting')).step).toBe(3);
  expect((await goal()).label).toBe('Brenna Stoneheart');

  // Set the block down by the table and hand it in: Brenna sends you on to Hob.
  await w.cmd({ t: 'drop' });
  await quiet(2);
  await toNpc('brenna');
  await press();
  await card.locator('[data-act="quest"][data-arg="stonecutting"]').click();
  await card.locator('[data-act="complete"]').click();
  await quiet(2);
  await page.evaluate(() => window.__game.render());
  await card.locator('[data-act="quest"][data-arg="woodcutting"]').click();
  await card.locator('[data-act="accept"]').click();
  await quiet(1);
  await close();
  expect((await w.life()).quests.done).toContain('stonecutting');
  expect((await goal()).label).toBe('Hob Ashgrove');

  // Hob's camp: the deadfall, then his sawhorse.
  await toNpc('hob');
  await press();
  await close();
  expect((await goal()).label).toBe('Deadfall Timber');
  for (const nd of z.nodes.filter((n: { kind: string }) => n.kind === 'timberNode')) {
    if ((await progress('woodcutting')).step > 1) break;
    await goTo(nd.x, nd.z + 2, Math.PI);
    expect((await w.life()).focus.label).toBe('Chop Timber');
    await press();
  }
  expect((await goal()).label).toBe("Hob's Sawhorse");
  const saw = z.workbenches.find((b: { id: string }) => b.id === 'sawhorse');
  await goTo(saw.x, saw.z + 1.5, Math.PI);
  expect((await w.life()).focus.detail).toBe('Lumber Bundle');
  await w.cmd({ t: 'craft', recipe: 'pack.lumberBundle' });
  await quiet(2);
  expect((await goal()).label).toBe('Registrar Quill');

  // Quill takes it, with a seal toward the blueprint, and only now offers the house.
  const seals = (await w.life()).seals;
  await toNpc('quill');
  await w.cmd({ t: 'complete', quest: 'woodcutting' });
  await w.cmd({ t: 'accept', quest: 'home' });
  await quiet(2);
  expect((await w.life()).seals).toBe(seals + 1);
  expect((await progress('home')).step).toBe(0);
  // No blueprint yet: the marker stays on whoever sells them; with one, Hearthside Rise.
  expect((await goal()).label).toBe('Registrar Quill');
  await w.cmd({ t: 'grant', item: 'blueprint.cottage', n: 1 });
  await quiet(1);
  expect((await goal()).label).toBe('Hearthside Rise');
  const plot = z.housePlots[0];
  await goTo(plot.x, plot.z + 5, plot.rot + Math.PI);
  await press();
  // The foundation wants stone: the site says where it's cut, and the marker goes to the block you left.
  const l = await w.life();
  expect([l.focus.label, l.focus.detail]).toEqual(['Foundation Needs', 'Stone Block 0/2 (Stonebreak Quarry)']);
  const block = l.packs.find((p: { def: string }) => p.def === 'stoneBlock');
  expect(await goal()).toEqual({ x: block.x, z: block.z, label: 'Stone Block' });
  await page.evaluate(() => window.__game.pressLife('map'));
  await page.evaluate(() => window.__game.render());
  await expect(page.locator('#lui-quests')).toContainText('Build all four stages with packs from Stonebreak Quarry and Thornwood');
  await page.screenshot({ path: `${SHOTS}/world-13-building-lessons.png` });
  expect(errors).toEqual([]);
});

test('quest log: take a quest off the tracker and back, and give one up', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await faceNpc(page, 'hollis');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await w.cmd({ t: 'complete', quest: 'landfall' });
  await w.cmd({ t: 'accept', quest: 'patch' });
  await w.advance(2);
  await page.evaluate(() => window.__game.closeLifePanel());
  const tracker = page.locator('#lui-quests');
  await expect(tracker).toContainText('A Patch of Earth');
  await page.evaluate(() => window.__game.pressLife('quests'));
  await w.advance(1);
  const card = page.locator('.lui-card');
  const track = card.locator('[data-act="track"]');
  await expect(track).toHaveText('Untrack');
  await track.click();
  await w.advance(1);
  await expect(tracker).not.toContainText('A Patch of Earth');
  await expect(tracker).toContainText('1 more in your quest log');
  await expect(track).toHaveText('Track on Screen');
  await track.click();
  await w.advance(1);
  await expect(tracker).toContainText('A Patch of Earth');
  // Abandon asks once more; Keep leaves it be.
  await card.locator('[data-act="ask"]').click();
  await expect(card).toContainText('Give it up?');
  await card.locator('[data-act="keep"]').click();
  await w.advance(1);
  expect((await w.life()).quests.active.map((x: { id: string }) => x.id)).toContain('patch');
  await card.locator('[data-act="ask"]').click();
  await card.locator('[data-act="abandon"]').click();
  await w.advance(2);
  expect((await w.life()).quests.active.map((x: { id: string }) => x.id)).not.toContain('patch');
  await expect(page.locator('#lui-toasts')).toContainText('Quest abandoned: A Patch of Earth');
  await expect(tracker).not.toContainText('A Patch of Earth');
  // A milestone has neither button.
  await card.locator('[data-act="logsel"][data-arg="wayfarer"]').click();
  await w.advance(1);
  await expect(card.locator('[data-act="ask"], [data-act="track"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('merchant: buy back what you sold, until you walk off', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await grant(page, [['sunroot', 5]], { coins: 100 });
  const sunroot = async () => ((await w.life()).bag as Array<{ item: string; n: number }>).filter((s) => s.item === 'sunroot').reduce((n, s) => n + s.n, 0);
  const shop = async (tab: string) => {
    await faceNpc(page, 'mara');
    await w.cmd({ t: 'interact' });
    await w.advance(2);
    await page.locator('.lui-card [data-act="shop"]').click();
    await page.locator(`.lui-card [data-act="tab"][data-arg="${tab}"]`).click();
  };
  await shop('sell');
  await page.locator('.lui-card [data-act="sell"][data-arg="sunroot"]').click({ modifiers: ['Shift'] });
  await w.advance(2);
  expect(await sunroot()).toBe(0);
  await page.locator('.lui-card [data-act="tab"][data-arg="buyback"]').click();
  const held = page.locator('.lui-card [data-act="buyback"][data-arg="sunroot"]');
  await expect(held.locator('.n')).toHaveText('5');
  await held.click();
  await w.advance(2);
  await expect(held.locator('.n')).toHaveText('4');
  expect(await sunroot()).toBe(1);
  // Walk off and come back: she has let go of the rest.
  await page.evaluate(() => window.__game.closeLifePanel());
  const mara = (await w.zone()).npcs.find((n: { id: string }) => n.id === 'mara');
  await w.teleport(mara.x + 20, mara.z, 0);
  await w.advance(2);
  await shop('buyback');
  await expect(page.locator('.lui-card')).toContainText('Nothing to buy back');
  expect((await w.life()).buyback).toEqual([]);
  expect(errors).toEqual([]);
});

test('panels: bag, map, vehicles, quest log, shop and workbench open without errors', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await grant(
    page,
    [
      ['deed.farmCart', 1],
      ['seed.sunroot', 5],
      ['sunroot', 6],
      ['barley', 4],
    ],
    { coins: 5000 },
  );
  for (const k of ['bag', 'map', 'garage', 'quests', 'dev'] as const) {
    await page.evaluate((x) => window.__game.pressLife(x), k);
    await w.advance(1);
    await page.evaluate(() => window.__game.render());
    expect(await page.evaluate(() => window.__game.lifePanel())).not.toBeNull();
    if (k === 'map' || k === 'bag') await page.screenshot({ path: `${SHOTS}/world-09-${k}.png` });
    await page.evaluate(() => window.__game.closeLifePanel());
  }
  await faceNpc(page, 'mara');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await page.locator('.lui-card [data-act="shop"]').click();
  await expect(page.locator('.lui-card')).toContainText("Mara's Stall");
  await page.locator('.lui-card [data-act="buy"]').first().click();
  await w.advance(2);
  expect((await w.life()).bag.find((s: { item: string }) => s.item === 'seed.sunroot').n).toBe(6);
  await page.evaluate(() => window.__game.closeLifePanel());
  const z = await w.zone();
  const wb = z.workbenches[0];
  await w.teleport(wb.x, wb.z + 2, Math.PI);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await expect(page.locator('.lui-card')).toContainText('Harvest Crate');
  await page.screenshot({ path: `${SHOTS}/world-10-workbench.png` });
  expect(errors).toEqual([]);
});

test('livestock: raise a chick on barley until it lays, and collect the eggs', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [
    ['scarecrow', 1],
    ['animal.chick', 1],
    ['barley', 10],
  ]);
  await w.teleport(-150, -222, 0);
  await w.cmd({ t: 'use', item: 'scarecrow' });
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  const sc = (await w.life()).scarecrows[0];
  await w.cmd({ t: 'use', item: 'animal.chick' });
  const c = { x: sc.x + -3 * Math.cos(sc.rot) + -3 * Math.sin(sc.rot), z: sc.z - -3 * Math.sin(sc.rot) + -3 * Math.cos(sc.rot) };
  await w.teleport(c.x - Math.sin(sc.rot) * 1.3, c.z - Math.cos(sc.rot) * 1.3, sc.rot);
  await w.advance(1);
  const f = (await w.life()).focus;
  expect(f.action).toBe('plant');
  expect(f.label).toContain('Raise');
  await w.cmd({ t: 'interact' });
  await w.advance(1);
  let cell = (await w.life()).scarecrows[0].cells[0];
  expect(cell.animal).toBe(true);
  // Drawn standing on the field, not buried under it (the model animates its own root).
  const drawn = await page.evaluate(() => window.__game.sceneObjects('animal:'));
  expect(drawn.length).toBe(1);
  expect(drawn[0].y).toBeGreaterThan((await w.ground(c.x, c.z)) - 0.3);
  // Fed when it arrives: it grows up, then lays.
  await w.cmd({ t: 'warp', seconds: 200 });
  await w.advance(1);
  cell = (await w.life()).scarecrows[0].cells[0];
  expect(cell.growth).toBe(1);
  // Hungry now: nothing more happens until it is fed.
  await w.cmd({ t: 'warp', seconds: 400 });
  await w.advance(1);
  expect((await w.life()).focus.action).toBe('feed');
  const before = (await w.life()).scarecrows[0].cells[0].produce;
  await w.cmd({ t: 'interact' });
  await w.advance(1);
  expect((await w.life()).bag.find((s: { item: string }) => s.item === 'barley')?.n).toBe(8);
  await w.cmd({ t: 'warp', seconds: 130 });
  await w.advance(1);
  cell = (await w.life()).scarecrows[0].cells[0];
  expect(cell.produce).toBeGreaterThan(before ?? 0);
  expect((await w.life()).focus.action).toBe('collect');
  await w.cmd({ t: 'interact' });
  await w.advance(1);
  expect((await w.life()).bag.find((s: { item: string }) => s.item === 'egg')?.n).toBeGreaterThanOrEqual(2);
});

test('quests credit what you had already done, and a full bag refuses work instead of eating it', async ({ page }) => {
  await open(page);
  const w = g(page);
  // Finish the first quest for the scarecrow, and put the plot down *before* taking the next quest.
  await faceNpc(page, 'hollis');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await w.cmd({ t: 'complete', quest: 'landfall' });
  await w.advance(2);
  await page.evaluate(() => window.__game.closeLifePanel());
  await w.teleport(-150, -222, 0);
  await w.cmd({ t: 'use', item: 'scarecrow' });
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.life()).scarecrows.length).toBe(1);
  await w.cmd({ t: 'accept', quest: 'patch' });
  await w.advance(1);
  const q = (await w.life()).quests.active.find((x: { id: string }) => x.id === 'patch');
  // The plot already stands, so the quest starts on its second step.
  expect(q.step).toBe(1);

  // Fill every slot with stone, then try to chop timber: the bag has no room, so nothing is spent.
  await grant(page, [['stone', 30 * 200]], { labor: 200 });
  const z = await w.zone();
  const nd = z.nodes.find((n: { kind: string }) => n.kind === 'timberNode');
  await w.teleport(nd.x, nd.z + 2.6, Math.PI);
  await w.advance(2);
  const before = await w.life();
  expect(before.bag.length).toBe(30);
  expect(before.focus?.action).toBe('gather');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  const after = await w.life();
  expect(after.labor).toBeCloseTo(before.labor, 0);
  expect(after.bag.some((s: { item: string }) => s.item === 'lumber')).toBe(false);
  // The node was not used up either.
  expect((await w.life()).focus?.action).toBe('gather');
});
