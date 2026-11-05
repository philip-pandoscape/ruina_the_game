import { expect, test, type Page } from '@playwright/test';
import { sailEfficiency } from '../src/sim/life/vehicles';
import { skillsFrom } from '../src/skills';
import { COMBAT, emptyMovement, HOTBAR_SLOTS, NO_ABILITY, SLIDE_SKILL } from '../src/tuning';

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
  await page.goto(`/?world&test${extra}`);
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__game.reset());
  return errors;
}

const g = (page: Page) => ({
  advance: (frames: number, a: Actions = {}) => page.evaluate(([n, x]) => (window as any).__game.advance(n, x), [frames, a] as const),
  player: () => page.evaluate(() => (window as any).__game.state().player),
  life: () => page.evaluate(() => (window as any).__game.life()),
  zone: () => page.evaluate(() => (window as any).__game.zone()),
  cmd: (c: Record<string, unknown>) => page.evaluate((x) => (window as any).__game.lifeCommand(x), c),
  teleport: (x: number, z: number, facing = 0) => page.evaluate(([a, b, c]) => (window as any).__game.teleport(a, b, c), [x, z, facing] as const),
  ground: (x: number, z: number) => page.evaluate(([a, b]) => (window as any).__game.ground(a, b), [x, z] as const),
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

test('the open world loads: island, sea, townsfolk and HUD, without errors', async ({ page }) => {
  const errors = await open(page);
  const w = g(page);
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: 0.25, pitch: 0.28, distance: 9 }));
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
  const perf = await page.evaluate(() => (window as any).__game.perf());
  console.log('world render', { drawCalls: perf.drawCalls, triangles: perf.triangles });
  expect(perf.drawCalls).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('you stand on the island, not inside it: arriving, and getting up after a knock-down', async ({ page }) => {
  // No reset here: this is the island as a fresh page starts it.
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  const aboveGround = () =>
    page.evaluate(() => {
      const game = (window as any).__game;
      const p = game.state().player;
      return p.pos.y - game.ground(p.pos.x, p.pos.z);
    });
  // The spawn is on a hill, well above sea level.
  const start = await g(page).player();
  expect(await page.evaluate(([x, z]) => (window as any).__game.ground(x, z), [start.pos.x, start.pos.z])).toBeGreaterThan(1);
  expect(Math.abs(await aboveGround())).toBeLessThan(0.05);
  // Knocked flat, then back up at the spawn: on the hill again.
  await page.evaluate(() => (window as any).__game.takeHit(1000, 0, 1, 0));
  expect((await g(page).player()).downFrame).toBeGreaterThanOrEqual(0);
  await g(page).advance(COMBAT.downFrames + 10);
  const p = await g(page).player();
  expect(p.downFrame).toBe(-1);
  expect(Math.abs(await aboveGround())).toBeLessThan(0.05);
});

test('terrain: you follow the hills, but cliffs stop you', async ({ page }) => {
  await open(page);
  const w = g(page);
  // Up the north road out of the village: grounded the whole way, feet on the ground.
  await w.teleport(0, -200, 0);
  let maxGap = 0;
  for (let i = 0; i < 12; i++) {
    await w.advance(10, { moveZ: 1 });
    const p = await w.player();
    if (p.grounded) maxGap = Math.max(maxGap, Math.abs(p.pos.y - (await w.ground(p.pos.x, p.pos.z))));
  }
  expect(maxGap).toBeLessThan(0.06);
  // Run straight north at the Windspire from the meadows: up its skirt, then the cliff stops you
  // long before the top (only the ledge path, further east, climbs it).
  await w.teleport(40, 120, 0);
  await w.advance(360, { moveZ: 1 });
  const p = await w.player();
  console.log('stopped by the cliff at', p.pos.z.toFixed(1), 'height', p.pos.y.toFixed(1));
  expect(p.pos.y).toBeLessThan(70);
  expect(p.pos.z).toBeLessThan(215);
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
  expect(await page.evaluate(() => (window as any).__game.heroWeapon()), 'the weapon, swimming').toBe('hidden');
  await page.screenshot({ path: `${SHOTS}/world-02-swimming.png` });
  // Turn round and swim back to shore.
  let walking = false;
  for (let i = 0; i < 90 && !walking; i++) {
    await w.advance(10, { moveX: -dx / l, moveZ: -dz / l });
    walking = (await w.player()).mode === 'normal';
  }
  expect(walking).toBe(true);
});

test('glider: jump, jump, jump again off the Windspire and glide most of the way to the sea', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['glider.wayfarer', 1]]);
  await w.cmd({ t: 'use', item: 'glider.wayfarer' });
  const z = await w.zone();
  const spire = z.places.find((p: { id: string }) => p.id === 'windspire');
  await w.teleport(spire.x, spire.z - 5, Math.PI);
  await w.advance(30, { moveZ: -1 });
  // Run off the edge, then press jump until the wing opens (jump, double jump, open).
  for (let i = 0; i < 4 && (await w.player()).mode !== 'glide'; i++) {
    await w.advance(1, { moveZ: -1, jumpPressed: true, jumpHeld: true });
    await w.advance(10, { moveZ: -1 });
  }
  let p = await w.player();
  expect(p.mode).toBe('glide');
  const start = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  await w.advance(120, { moveZ: -1 });
  await page.evaluate(() => (window as any).__game.setCamera({ distance: 9 }));
  await w.advance(1, { moveZ: -1 });
  await page.screenshot({ path: `${SHOTS}/world-03-gliding.png` });
  for (let i = 0; i < 40 && (await w.player()).mode === 'glide'; i++) await w.advance(60, { moveZ: -1 });
  p = await w.player();
  const dist = Math.hypot(p.pos.x - start.x, p.pos.z - start.z);
  console.log('glide', { dist: Math.round(dist), drop: Math.round(start.y - p.pos.y) });
  // A gentle glider: well over five metres forward for every metre down.
  expect(dist / (start.y - p.pos.y)).toBeGreaterThan(4.5);
  expect(dist).toBeGreaterThan(450);
  const l = await w.life();
  expect(l.stats.glideSeconds).toBeGreaterThan(30);
});

test('glider: rising air at the foot of the Windspire lifts you; C flares it and lands you crouched; a trade pack keeps it shut', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['glider.wayfarer', 1], ['sunroot', 6], ['barley', 4]]);
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
  const live = (n: number, drawn = true) => page.evaluate(([k, d]) => (window as any).__game.advanceLive(k, d), [n, drawn] as const);
  const slides = () => page.evaluate((id) => (window as any).__game.events().filter((e: any) => e.type === 'action' && e.id === id).length, SLIDE_SKILL);
  const before = await slides();
  await page.keyboard.down('KeyC');
  await live(45, false);
  p = await w.player();
  expect(p.mode).toBe('glide');
  expect(p.airspeed).toBeLessThan(opened - 1);
  // Down to the ground in the page, drawn once there.
  await page.evaluate(() => {
    const game = (window as any).__game;
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

test('farming: a scarecrow plot, planting, watering, growing and harvesting', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['scarecrow', 1], ['seed.sunroot', 8]]);
  await w.teleport(-150, -222, 0);
  await w.cmd({ t: 'use', item: 'scarecrow' });
  await w.advance(2);
  expect((await w.life()).placing).not.toBeNull();
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  const sc = (await w.life()).scarecrows[0];
  expect(sc).toBeTruthy();
  // Stand behind two cells of the front row and plant them.
  const cell = (col: number, row: number) => {
    const lx = (col - 1.5) * 2;
    const lz = (row - 1.5) * 2;
    return { x: sc.x + lx * Math.cos(sc.rot) + lz * Math.sin(sc.rot), z: sc.z - lx * Math.sin(sc.rot) + lz * Math.cos(sc.rot) };
  };
  for (const col of [0, 1]) {
    const c = cell(col, 0);
    await w.teleport(c.x - Math.sin(sc.rot) * 1.3, c.z - Math.cos(sc.rot) * 1.3, sc.rot);
    await w.advance(1);
    expect((await w.life()).focus?.action).toBe('plant');
    await w.cmd({ t: 'interact' });
    await w.advance(1);
  }
  // Water only the first.
  const c0 = cell(0, 0);
  await w.teleport(c0.x - Math.sin(sc.rot) * 1.3, c0.z - Math.cos(sc.rot) * 1.3, sc.rot);
  await w.advance(1);
  expect((await w.life()).focus?.action).toBe('water');
  await w.cmd({ t: 'interact' });
  await w.advance(600);
  const cells = (await w.life()).scarecrows[0].cells;
  console.log('growth watered vs dry', cells[0].growth.toFixed(3), cells[1].growth.toFixed(3));
  expect(cells[0].watered).toBe(true);
  expect(cells[0].growth).toBeGreaterThan(cells[1].growth * 1.15);
  // Let it ripen and harvest.
  await w.cmd({ t: 'warp', seconds: 300 });
  await w.advance(2);
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: 0.6, pitch: 0.5, distance: 8 }));
  await w.advance(1);
  await page.screenshot({ path: `${SHOTS}/world-04-farm.png` });
  expect((await w.life()).focus?.action).toBe('harvest');
  const before = (await w.life()).labor;
  await w.cmd({ t: 'interact' });
  await w.advance(1);
  const l = await w.life();
  expect(l.bag.find((s: { item: string }) => s.item === 'sunroot')?.n).toBeGreaterThanOrEqual(3);
  expect(l.labor).toBeLessThan(before);
  expect(l.scarecrows[0].cells[0]).toBeNull();
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
  const meteor = 1;
  const mage = { skills: skillsFrom('staff', 'meteor'), weapon: 2, abilities: [meteor, ...new Array(HOTBAR_SLOTS - 1).fill(NO_ABILITY)], movement: emptyMovement() };
  expect(await page.evaluate((b) => (window as any).__game.setBuild(b), mage)).toBe(true);
  const corner = at(4, -4);
  const p = await w.player();
  await page.evaluate(([dx, dz]) => (window as any).__game.advance(1, { abilitySlot: 1, aimX: dx, aimZ: dz }), [corner.x - p.pos.x, corner.z - p.pos.z] as const);
  await w.advance(20);
  expect((await w.player()).mode).toBe('cast');
  const seen = await page.evaluate(
    ([cx, cz, r]) => {
      const g = (window as any).__game;
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
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: Math.PI / 6 + 0.5, pitch: 0.75, distance: 11 }));
  await w.advance(1);
  await page.screenshot({ path: `${SHOTS}/world-05-farm-warning.png` });
  await w.advance(90);

  // Standing on a furrow, the shadow under you lies on it rather than under the soil.
  const row = at(-1, -1);
  await w.teleport(row.x, row.z, 0);
  await w.advance(2);
  const shadow = await page.evaluate(() => {
    const g = (window as any).__game;
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
  await grant(page, [['sunroot', 12], ['barley', 8]]);
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
  const [worn] = await page.evaluate(() => (window as any).__game.sceneObjects('pack:'));
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
  await grant(page, [['deed.farmCart', 1], ['sunroot', 12], ['barley', 8]]);
  const z = await w.zone();
  const wb = z.workbenches[0];
  await w.teleport(wb.x - 6, wb.z + 6, 0);
  await w.cmd({ t: 'summon', item: 'deed.farmCart' });
  await w.advance(2);
  let cart = (await w.life()).vehicles[0];
  expect(cart?.def).toBe('farmCart');
  const weapon = () => page.evaluate(() => (window as any).__game.heroWeapon());
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

test('vehicles: a roadster slides when you pull the handbrake mid-turn', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['deed.roadster', 1]]);
  // The long west road, facing west.
  await w.teleport(150, -210, Math.PI / 2 + 0.25);
  await w.cmd({ t: 'summon', item: 'deed.roadster' });
  await w.advance(2);
  const car = (await w.life()).vehicles[0];
  await w.teleport(car.x + Math.cos(car.heading) * 1.8, car.z - Math.sin(car.heading) * 1.8, car.heading);
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await w.advance(100, { stickY: 1 });
  const fast = (await w.life()).vehicles[0];
  expect(Math.abs(fast.speed)).toBeGreaterThan(12);
  const slip = async (handbrake: boolean) => {
    await w.advance(18, { stickY: 1, stickX: 1, jumpHeld: handbrake });
    const v = (await w.life()).vehicles[0];
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    return Math.abs(v.vx * -fz + v.vz * fx);
  };
  const drift = await slip(true);
  console.log('roadster lateral slide with handbrake', drift.toFixed(2));
  expect(drift).toBeGreaterThan(1.5);
});

test('boats: a rowboat at the docks, and a sloop runs faster with the wind behind it', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['deed.rowboat', 1], ['deed.sloop', 1]]);
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
  expect(await page.evaluate(() => (window as any).__game.heroWeapon()), 'the weapon at the helm').toBe('hidden');
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
  await grant(page, [['whistle.horse', 1], ['sunroot', 6], ['barley', 4]]);
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
  expect(await page.evaluate(() => (window as any).__game.heroWeapon()), 'the weapon in the saddle').toBe('hidden');
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

test('housing: claim a plot and raise a cottage from hauled material packs', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['blueprint.cottage', 1], ['lumber', 50], ['stone', 30], ['ironOre', 6]]);
  const z = await w.zone();
  const plot = z.housePlots[4];
  const site = { x: plot.x, z: plot.z + 5 };
  await w.teleport(site.x, site.z, plot.rot + Math.PI);
  await w.advance(2);
  expect((await w.life()).focus?.action).toBe('claim');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.life()).houses.length).toBe(1);
  const bench = (id: string) => z.workbenches.find((b: { id: string }) => b.id === id);
  const haul = async (recipe: string, at: string) => {
    const b = bench(at);
    await w.teleport(b.x, b.z + 2, Math.PI);
    await w.cmd({ t: 'craft', recipe });
    await w.advance(2);
    await w.teleport(site.x, site.z, plot.rot + Math.PI);
    await w.advance(2);
    expect((await w.life()).focus?.action).toBe('deliver');
    await w.cmd({ t: 'interact' });
    await w.advance(2);
  };
  const build = async () => {
    await w.teleport(site.x, site.z, plot.rot + Math.PI);
    await w.advance(2);
    expect((await w.life()).focus?.action).toBe('build');
    await w.cmd({ t: 'interact' });
    await w.advance(2);
  };
  await haul('pack.stoneBlock', 'stonecutter');
  await haul('pack.stoneBlock', 'stonecutter');
  await build();
  await haul('pack.lumberBundle', 'sawhorse');
  await haul('pack.lumberBundle', 'sawhorse');
  await build();
  await haul('pack.lumberBundle', 'sawhorse');
  await haul('pack.lumberBundle', 'sawhorse');
  await haul('pack.stoneBlock', 'stonecutter');
  await build();
  await haul('pack.lumberBundle', 'sawhorse');
  await haul('pack.ironCrate', 'stonecutter');
  await build();
  const l = await w.life();
  expect(l.houses[0].stage).toBe(4);
  expect(l.stats.built).toBe(4);
  await w.teleport(site.x + 7, site.z + 8, plot.rot + Math.PI + 0.6);
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: Math.PI + 0.5, pitch: 0.3, distance: 12 }));
  await w.advance(2);
  await page.screenshot({ path: `${SHOTS}/world-07-cottage.png` });
  // The walls are solid: walking at the side wall from outside stops at it.
  await w.teleport(plot.x + 7, plot.z - 2.5, -Math.PI / 2);
  await w.advance(90, { moveX: -1 });
  expect((await w.player()).pos.x).toBeGreaterThan(plot.x + 3.6);
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
  await page.evaluate(() => (window as any).__game.closeLifePanel());
  await w.teleport(-150, -222, 0);
  await w.cmd({ t: 'use', item: 'scarecrow' });
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  l = await w.life();
  const q = l.quests.active.find((x: { id: string }) => x.id === 'patch');
  expect(q.step).toBe(1);
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
  await page.evaluate(() => (window as any).__game.closeLifePanel());
  const tracker = page.locator('#lui-quests');
  await expect(tracker).toContainText('A Patch of Earth');
  await page.evaluate(() => (window as any).__game.pressLife('quests'));
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
  await page.evaluate(() => (window as any).__game.closeLifePanel());
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
  await grant(page, [['deed.farmCart', 1], ['seed.sunroot', 5], ['sunroot', 6], ['barley', 4]], { coins: 5000 });
  for (const k of ['bag', 'map', 'garage', 'quests', 'dev']) {
    await page.evaluate((x) => (window as any).__game.pressLife(x), k);
    await w.advance(1);
    await page.evaluate(() => (window as any).__game.render());
    expect(await page.evaluate(() => (window as any).__game.lifePanel())).not.toBeNull();
    if (k === 'map' || k === 'bag') await page.screenshot({ path: `${SHOTS}/world-09-${k}.png` });
    await page.evaluate(() => (window as any).__game.closeLifePanel());
  }
  await faceNpc(page, 'mara');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await page.locator('.lui-card [data-act="shop"]').click();
  await expect(page.locator('.lui-card')).toContainText("Mara's Stall");
  await page.locator('.lui-card [data-act="buy"]').first().click();
  await w.advance(2);
  expect((await w.life()).bag.find((s: { item: string }) => s.item === 'seed.sunroot').n).toBe(6);
  await page.evaluate(() => (window as any).__game.closeLifePanel());
  const z = await w.zone();
  const wb = z.workbenches[0];
  await w.teleport(wb.x, wb.z + 2, Math.PI);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  await expect(page.locator('.lui-card')).toContainText('Harvest Crate');
  await page.screenshot({ path: `${SHOTS}/world-10-workbench.png` });
  expect(errors).toEqual([]);
});

test('saving: your island comes back after a reload, with time having passed', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['seed.sunroot', 3]], { coins: 777 });
  await w.teleport(120, -150, 1);
  await w.advance(2);
  const before = await w.life();
  await page.evaluate(() => (window as any).__game.saveNow());
  await page.goto('/?world&test&load');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  const after = await g(page).life();
  expect(after.coins).toBe(before.coins);
  expect(after.bag).toEqual(before.bag);
  expect(after.clock).toBeGreaterThanOrEqual(before.clock);
  const p = await g(page).player();
  expect(Math.hypot(p.pos.x - 120, p.pos.z + 150)).toBeLessThan(1);
  await page.evaluate(() => (window as any).__game.clearSave());
});

test('combat on the hills: an arrow finds a slime standing well above sea level', async ({ page }) => {
  await open(page);
  const w = g(page);
  // Learn the bow and take it up.
  const archer = { skills: skillsFrom('bow'), weapon: 3, abilities: new Array(HOTBAR_SLOTS).fill(NO_ABILITY), movement: emptyMovement() };
  const ok = await page.evaluate((b) => (window as any).__game.setBuild(b), archer);
  expect(ok).toBe(true);
  const z = await w.zone();
  const meadow = z.places.find((p: { id: string }) => p.id === 'meadow');
  await w.teleport(meadow.x, meadow.z - 6, 0);
  const me = await w.player();
  expect(me.pos.y).toBeGreaterThan(8);
  // One slime right in front, the rest out of the way.
  const slimes = await page.evaluate(() => (window as any).__game.actors('slime'));
  await page.evaluate(([x, zz]) => (window as any).__game.placeActor('slime', 0, x, zz), [me.pos.x, me.pos.z + 3] as const);
  for (let i = 1; i < slimes.length; i++) await page.evaluate(([k]) => (window as any).__game.placeActor('slime', k, 60 + k * 3, 40), [i] as const);
  await w.advance(1, { attackPressed: true });
  await w.advance(90);
  const after = await page.evaluate(() => (window as any).__game.actors('slime'));
  expect(after[0].hp).toBeLessThan(slimes[0].hp);
});

test('combat on the hills: sword, club and staff swings land on a slime and on the dummy', async ({ page }) => {
  await open(page);
  const w = g(page);
  const game = {
    actors: (kind: string) => page.evaluate((k) => (window as any).__game.actors(k), kind),
    place: (kind: string, i: number, x: number, z: number) =>
      page.evaluate(([k, n, a, b]) => (window as any).__game.placeActor(k, n, a, b), [kind, i, x, z] as const),
    wield: (weapon: number, skill: string) =>
      page.evaluate(
        (b) => (window as any).__game.setBuild(b),
        { skills: skillsFrom(skill), weapon, abilities: new Array(HOTBAR_SLOTS).fill(NO_ABILITY), movement: emptyMovement() },
      ),
  };
  const z = await w.zone();
  const meadow = z.places.find((p: { id: string }) => p.id === 'meadow');
  const slimes = await game.actors('slime');
  for (let i = 0; i < slimes.length; i++) await game.place('slime', i, 60 + i * 3, 40);

  // A fresh slime for each weapon, a step in front of you, high on the meadow's hillside.
  const weapons = [[0, 'sword'], [1, 'club'], [2, 'staff']] as const;
  for (const [k, [weapon, skill]] of weapons.entries()) {
    expect(await game.wield(weapon, skill)).toBe(true);
    await w.teleport(meadow.x, meadow.z - 6, 0);
    const me = await w.player();
    expect(me.pos.y).toBeGreaterThan(8);
    await game.place('slime', k, me.pos.x, me.pos.z + 1.2);
    await w.advance(1, { attackPressed: true });
    await w.advance(40);
    const hp = (await game.actors('slime'))[k].hp;
    expect(hp, `a ${skill} swing on the hillside`).toBeLessThan(slimes[k].hp);
    await game.place('slime', k, 60 + k * 3, 40);
  }

  // The practice dummy at the meadow's edge: stand in front of it and swing the sword.
  expect(await game.wield(0, 'sword')).toBe(true);
  const [dummy] = await game.actors('dummy');
  await w.teleport(dummy.x, dummy.z - 1.3, 0);
  const me = await w.player();
  expect(me.pos.y).toBeGreaterThan(2);
  await w.advance(1, { attackPressed: true });
  await w.advance(40);
  const [hit] = await game.actors('dummy');
  expect(hit.hp, 'a sword swing at the dummy').toBeLessThan(dummy.hp);

  // ...but a swing does not reach down a cliff: from a rock edge on the Windspire's lower slopes,
  // a slime a step away but 3 m below your feet is out of reach.
  const edge = { x: -8, z: 202, facing: 4.32 };
  const below = { x: edge.x + Math.sin(edge.facing) * 1.3, z: edge.z + Math.cos(edge.facing) * 1.3 };
  await w.teleport(edge.x, edge.z, edge.facing);
  await w.advance(2);
  const top = await w.player();
  expect(top.grounded).toBe(true);
  expect(top.pos.y - (await w.ground(below.x, below.z)), 'the drop off the edge').toBeGreaterThan(2.5);
  await game.place('slime', 3, below.x, below.z);
  await w.advance(1, { attackPressed: true });
  await w.advance(20);
  expect((await game.actors('slime'))[3].hp, 'a slime 3 m down the cliff').toBe(slimes[3].hp);
});

test('the ledge path really climbs the Windspire on foot', async ({ page }) => {
  await open(page);
  const w = g(page);
  const path: Array<[number, number]> = await page.evaluate(() => (window as any).__game.rampPath(0));
  expect(path.length).toBeGreaterThan(50);
  await w.teleport(path[0][0], path[0][1] - 6, 0);
  // Steer at a point a few metres ahead on the path, the way a player follows it.
  const result = await page.evaluate((pts) => {
    const game = (window as any).__game;
    let k = 0;
    let frames = 0;
    while (k < pts.length - 1 && frames < 60 * 120) {
      const p = game.state().player;
      let best = k;
      let bd = Infinity;
      for (let j = k; j < Math.min(pts.length, k + 40); j++) {
        const d = Math.hypot(pts[j][0] - p.pos.x, pts[j][1] - p.pos.z);
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      k = best;
      const [tx, tz] = pts[Math.min(pts.length - 1, k + 3)];
      const dx = tx - p.pos.x;
      const dz = tz - p.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      game.advance(6, { moveX: dx / l, moveZ: dz / l });
      frames += 6;
    }
    return { y: game.state().player.pos.y, seconds: frames / 60 };
  }, path);
  console.log('climbed the Windspire', result);
  expect(result.y).toBeGreaterThan(120);
});

test('shipyard: lay a keel, build the Merchant Cog in four stages, launch her and sail', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['design.cog', 1], ['lumber', 90], ['ironOre', 18], ['flax', 30]], { labor: 600 });
  const z = await w.zone();
  const bench = (id: string) => z.workbenches.find((b: { id: string }) => b.id === id);
  const slip = { x: 48, z: -341 };
  const atSlip = async () => {
    await w.teleport(slip.x + 6, slip.z + 8, -2.4);
    await w.advance(2);
  };
  await atSlip();
  expect((await w.life()).focus?.action).toBe('keel');
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.life()).ships.length).toBe(1);
  const haul = async (recipe: string, at: string) => {
    const b = bench(at);
    await w.teleport(b.x, b.z + 2, Math.PI);
    await w.cmd({ t: 'craft', recipe });
    await w.advance(2);
    await atSlip();
    expect((await w.life()).focus?.action).toBe('shipDeliver');
    await w.cmd({ t: 'interact' });
    await w.advance(2);
  };
  const build = async () => {
    await atSlip();
    expect((await w.life()).focus?.action).toBe('shipBuild');
    await w.cmd({ t: 'interact' });
    await w.advance(2);
  };
  for (let i = 0; i < 3; i++) await haul('pack.lumberBundle', 'sawhorse');
  await build();
  for (let i = 0; i < 3; i++) await haul('pack.lumberBundle', 'sawhorse');
  for (let i = 0; i < 2; i++) await haul('pack.ironCrate', 'stonecutter');
  await build();
  await atSlip();
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: -2.2, pitch: 0.3, distance: 22 }));
  await w.advance(2);
  await page.screenshot({ path: `${SHOTS}/world-11-cog-hull.png` });
  for (let i = 0; i < 2; i++) await haul('pack.lumberBundle', 'sawhorse');
  await haul('pack.ironCrate', 'stonecutter');
  await build();
  for (let i = 0; i < 3; i++) await haul('pack.sailcloth', 'lanternwickBench');
  await haul('pack.lumberBundle', 'sawhorse');
  await build();
  await atSlip();
  expect((await w.life()).focus?.action).toBe('launch');
  await page.evaluate(() => (window as any).__game.setCamera({ yaw: -2.2, pitch: 0.3, distance: 26 }));
  await w.advance(2);
  await page.screenshot({ path: `${SHOTS}/world-12-cog-finished.png` });
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  let l = await w.life();
  expect(l.ships.length).toBe(0);
  expect(l.bag.some((s: { item: string }) => s.item === 'deed.cog')).toBe(true);
  // She floats.
  await w.teleport(0, -336, Math.PI);
  await w.cmd({ t: 'summon', item: 'deed.cog' });
  await w.advance(2);
  l = await w.life();
  const cog = l.vehicles.find((v: { def: string }) => v.def === 'cog');
  expect(cog).toBeTruthy();
  expect(cog.cargo.length).toBe(16);
});

test('livestock: raise a chick on barley until it lays, and collect the eggs', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['scarecrow', 1], ['animal.chick', 1], ['barley', 10]]);
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
  const drawn = await page.evaluate(() => (window as any).__game.sceneObjects('animal:'));
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

test('trade contracts: take one at a post, fill it, collect the bonus', async ({ page }) => {
  await open(page);
  const w = g(page);
  await w.advance(2);
  const offered = (await w.life()).contracts.offered.filter((k: { outpost: string }) => k.outpost === 'westwatch');
  expect(offered.length).toBe(2);
  const k = offered[0];
  await faceNpc(page, 'dunmore');
  await w.cmd({ t: 'contract', id: k.id });
  await w.advance(1);
  expect((await w.life()).contracts.active.length).toBe(1);
  const z = await w.zone();
  const wb = z.workbenches[0];
  const recipe = `pack.${k.pack}`;
  const ingredients: Record<string, Array<[string, number]>> = {
    harvestCrate: [['sunroot', 6], ['barley', 4]], flaxBale: [['flax', 8]], emberPreserves: [['emberberry', 8], ['apple', 2]],
    ciderCask: [['apple', 8]], fleeceBale: [['wool', 8]], hamper: [['egg', 4], ['milk', 3], ['sunroot', 4]],
  };
  const seals0 = (await w.life()).seals;
  for (let i = 0; i < k.count; i++) {
    await grant(page, ingredients[k.pack]);
    await w.teleport(wb.x, wb.z + 2, Math.PI);
    await w.cmd({ t: 'craft', recipe });
    await w.advance(2);
    await faceNpc(page, 'dunmore');
    await w.cmd({ t: 'interact' });
    await w.advance(2);
  }
  const l = await w.life();
  expect(l.contracts.active.length).toBe(0);
  // Normal route seals per pack, plus the contract's bonus.
  expect(l.seals).toBe(seals0 + k.count + k.bonusSeals);
});

test('storms: a rowboat caught out at sea in the rain breaks up, and its cargo floats', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['deed.rowboat', 1], ['sunroot', 6], ['barley', 4]]);
  const z = await w.zone();
  const wb = z.workbenches[0];
  await w.teleport(wb.x, wb.z + 2, Math.PI);
  await w.cmd({ t: 'craft', recipe: 'pack.harvestCrate' });
  await w.advance(2);
  await w.teleport(-10, -334, Math.PI);
  await w.cmd({ t: 'summon', item: 'deed.rowboat' });
  await w.advance(2);
  let boat = (await w.life()).vehicles[0];
  // Load the crate at the stern, then take the oars.
  await w.teleport(boat.x - Math.sin(boat.heading) * 2.2, boat.z - Math.cos(boat.heading) * 2.2, boat.heading);
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.life()).vehicles[0].cargo.filter(Boolean).length).toBe(1);
  boat = (await w.life()).vehicles[0];
  await w.teleport(boat.x + Math.cos(boat.heading) * 1.4, boat.z - Math.sin(boat.heading) * 1.4, boat.heading);
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  // Row due south, out of the harbour mouth, until the water is deep.
  for (let i = 0; i < 80; i++) {
    const v = (await w.life()).vehicles[0];
    if ((await w.ground(v.x, v.z)) < -12) break;
    let d = (Math.PI - v.heading) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    await w.advance(30, { stickY: 1, stickX: Math.max(-1, Math.min(1, -d * 2)) });
  }
  const out = (await w.life()).vehicles[0];
  expect(await w.ground(out.x, out.z)).toBeLessThan(-8);
  // Wait for the rain (the first shower comes a few minutes in), holding position.
  await w.cmd({ t: 'warp', seconds: 250 });
  await w.advance(2);
  expect((await w.life()).weather.rainUntil).toBeGreaterThan((await w.life()).clock);
  const hp0 = (await w.life()).vehicles[0].hp;
  await w.advance(600);
  const hp1 = (await w.life()).vehicles[0]?.hp ?? 0;
  console.log('rowboat hull in a storm', Math.round(hp0), '->', Math.round(hp1));
  expect(hp1).toBeLessThan(hp0);
  for (let i = 0; i < 12 && (await w.life()).vehicles.length; i++) await w.advance(600);
  const l = await w.life();
  expect(l.vehicles.length).toBe(0);
  expect((await w.player()).mode).toBe('swim');
  const floating = l.packs.filter((p: { at: string }) => p.at === 'ground');
  expect(floating.length).toBe(1);
  // Out for repairs for a while.
  await w.cmd({ t: 'summon', item: 'deed.rowboat' });
  await w.advance(1);
  expect((await w.life()).vehicles.length).toBe(0);
});

test('glider gust: F in flight gives a burst of speed and lift, then needs to recover', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['glider.swiftwing', 1]]);
  await w.cmd({ t: 'use', item: 'glider.swiftwing' });
  const z = await w.zone();
  const spire = z.places.find((p: { id: string }) => p.id === 'windspire');
  await w.teleport(spire.x, spire.z - 5, Math.PI);
  await w.advance(30, { moveZ: -1 });
  for (let i = 0; i < 4 && (await w.player()).mode !== 'glide'; i++) {
    await w.advance(1, { moveZ: -1, jumpPressed: true, jumpHeld: true });
    await w.advance(10, { moveZ: -1 });
  }
  await w.advance(120, { moveZ: -1 });
  const before = await w.player();
  expect(before.mode).toBe('glide');
  await w.cmd({ t: 'gust' });
  await w.advance(2, { moveZ: -1 });
  const after = await w.player();
  expect(after.airspeed).toBeGreaterThan(before.airspeed + 4);
  expect(after.vel.y).toBeGreaterThan(before.vel.y);
  expect(after.gustFrames).toBeGreaterThan(0);
  const speed = after.airspeed;
  await w.cmd({ t: 'gust' });
  await w.advance(2, { moveZ: -1 });
  expect((await w.player()).airspeed).toBeLessThanOrEqual(speed);
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
  await page.evaluate(() => (window as any).__game.closeLifePanel());
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

test('vehicles: a sloop left with her sail up drifts to a stop; a second whistle brings the same donkey; Ilsa sells the cog', async ({ page }) => {
  await open(page);
  const w = g(page);
  await grant(page, [['deed.sloop', 1], ['whistle.donkey', 1]], { coins: 1000, seals: 6 });
  await w.teleport(-10, -334, Math.PI);
  await w.cmd({ t: 'summon', item: 'deed.sloop' });
  await w.advance(2);
  const sloop = (await w.life()).vehicles[0];
  await w.teleport(sloop.x + Math.cos(sloop.heading) * 2.4, sloop.z - Math.sin(sloop.heading) * 2.4, sloop.heading);
  await w.advance(2);
  await w.cmd({ t: 'interact' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  await w.advance(300, { stickY: 1 });
  expect((await w.life()).vehicles[0].sail).toBeGreaterThan(0.9);
  await w.cmd({ t: 'exit' });
  await w.advance(600);
  const adrift = (await w.life()).vehicles.find((v: { def: string }) => v.def === 'sloop');
  expect(adrift.sail).toBe(0);
  expect(Math.abs(adrift.speed)).toBeLessThan(0.5);

  // Whistle for the donkey, ride off and leave it, walk away and whistle again: still one donkey.
  await w.teleport(0, -200, 0);
  await w.advance(2);
  await w.cmd({ t: 'mount' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  await w.cmd({ t: 'mount' });
  await w.advance(2);
  await w.teleport(60, -170, 0);
  await w.advance(2);
  await w.cmd({ t: 'mount' });
  await w.advance(2);
  expect((await w.player()).mode).toBe('ride');
  expect((await w.life()).vehicles.filter((v: { def: string }) => v.def === 'donkey').length).toBe(1);
  await w.cmd({ t: 'mount' });
  await w.advance(2);

  // The Merchant Cog's design is for sale at the shipyard (you have to be there to buy it).
  await faceNpc(page, 'ilsa');
  await w.cmd({ t: 'buy', npc: 'ilsa', item: 'design.cog', n: 1 });
  await w.advance(1);
  expect((await w.life()).bag.some((s: { item: string }) => s.item === 'design.cog')).toBe(true);
});
