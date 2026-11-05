import { expect, test, type Page } from '@playwright/test';
import { isTitleCase } from '../src/ui/theme/text';

// The interface's own rules (design/ui.html): labels in Title Case, items answering a double-click
// and a right-click, the minimap pointing the way you face, portraits of whoever you talk to, and
// windows and HUD that don't cover each other. Offline, in the open world.

const SHOTS = 'screenshots';

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?world&test');
  await page.waitForFunction(() => (window as any).__game?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__game.reset());
  return errors;
}

const game = (page: Page) => ({
  advance: (n: number) => page.evaluate((k) => (window as any).__game.advance(k), n),
  press: (k: string) => page.evaluate((x) => (window as any).__game.pressLife(x), k),
  close: () => page.evaluate(() => (window as any).__game.closeLifePanel()),
  cmd: (c: Record<string, unknown>) => page.evaluate((x) => (window as any).__game.lifeCommand(x), c),
  life: () => page.evaluate(() => (window as any).__game.life()),
  panel: () => page.evaluate(() => (window as any).__game.lifePanel()),
  zone: () => page.evaluate(() => (window as any).__game.zone()),
  teleport: (x: number, z: number, facing: number) => page.evaluate(([a, b, c]) => (window as any).__game.teleport(a, b, c), [x, z, facing] as const),
});

/** Stands 1.6 m in front of an NPC, facing them. */
async function faceNpc(page: Page, id: string): Promise<void> {
  const g = game(page);
  const n = (await g.zone()).npcs.find((x: { id: string }) => x.id === id);
  await g.teleport(n.x + Math.sin(n.facing) * 1.6, n.z + Math.cos(n.facing) * 1.6, n.facing + Math.PI);
  await g.advance(2);
}

/** Every label in the open windows and the HUD that isn't in Title Case. */
async function untitled(page: Page): Promise<string[]> {
  const labels = await page.evaluate(() => {
    const sel = [
      '.lui-btn', '.mw-bar', '.mw .h', '.g-opts li > span', '.g-opts li > small', '.m-tab', '.ctx-i', '.ctx-h', '.hud-mbtn .lbl',
      '#hint > span', '#lui-prompt > span:not(.key):not(.detail)', '.ch-slot > span', '.ch-stats .r > span', '.ql-zone > span:first-child', '.set-row > span',
    ].join(',');
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((e) => e.offsetParent !== null)
      .map((e) => {
        // The label itself: without key caps, counts and nested notes.
        const c = e.cloneNode(true) as HTMLElement;
        c.querySelectorAll('.key, .k, small, b, .mny, svg, img').forEach((x) => x.remove());
        return c.textContent!.replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean);
  });
  return labels.filter((l) => !isTitleCase(l));
}

test('labels in every window are in Title Case', async ({ page }) => {
  const errors = await open(page);
  const g = game(page);
  for (const [item, n] of [['scarecrow', 1], ['seed.sunroot', 8], ['glider.wayfarer', 1], ['sunroot', 12]] as const) await g.cmd({ t: 'grant', item, n });
  await g.advance(2);
  const bad: string[] = [];
  bad.push(...(await untitled(page)));
  for (const k of ['bag', 'character', 'quests', 'garage', 'settings', 'dev']) {
    await g.press(k);
    await g.advance(2);
    bad.push(...(await untitled(page)).map((l) => `${k}: ${l}`));
    await g.close();
    await g.advance(1);
  }
  // Talking: a quest giver, a merchant (with the bag beside), a workbench.
  for (const npc of ['hollis', 'mara', 'tamsin']) {
    await faceNpc(page, npc);
    await g.press('interact');
    await g.advance(3);
    bad.push(...(await untitled(page)).map((l) => `${npc}: ${l}`));
    const talk = page.locator('.g-opts li[data-act="shop"], .g-opts li[data-act="craft"]').first();
    if (await talk.count()) {
      await talk.click();
      await g.advance(3);
      bad.push(...(await untitled(page)).map((l) => `${npc} (inside): ${l}`));
    }
    await g.close();
    await g.advance(1);
  }
  expect(bad).toEqual([]);
  expect(errors).toEqual([]);
});

test('bag items: a click picks one, a double-click places the scarecrow, a right-click lists what you can do', async ({ page }) => {
  await open(page);
  const g = game(page);
  await g.cmd({ t: 'grant', item: 'scarecrow', n: 1 });
  await g.cmd({ t: 'grant', item: 'sunroot', n: 12 });
  await g.advance(2);
  await g.press('bag');
  await g.advance(2);
  // No strip of buttons under the grid any more.
  await expect(page.locator('.lui-bag .bag-detail')).toHaveCount(0);
  const scarecrow = page.locator('.lui-bag [data-tip="item:scarecrow"]');
  await scarecrow.click();
  await expect(scarecrow).toHaveClass(/\bsel\b/);
  await expect(page.locator('.ctx')).toHaveCount(0);

  // Right-click: the main action first, in bold; produce away from a merchant says where to sell it.
  await scarecrow.click({ button: 'right' });
  await expect(page.locator('.ctx .ctx-h')).toHaveText('Scarecrow');
  await expect(page.locator('.ctx .ctx-i').first()).toHaveText('Place');
  await expect(page.locator('.ctx .ctx-i').first()).toHaveClass(/primary/);
  await page.screenshot({ path: `${SHOTS}/ui-01-item-menu.png` });
  // Escape closes the menu alone, not the bag behind it.
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx')).toHaveCount(0);
  await g.advance(1);
  expect(await g.panel()).toBe('bag');
  await page.locator('.lui-bag [data-tip="item:sunroot"]').click({ button: 'right' });
  await expect(page.locator('.ctx .ctx-i[disabled]')).toContainText('Sell');
  await page.keyboard.press('Escape');

  // Double-click: the scarecrow's main action, placing it; the bag gets out of the way.
  await scarecrow.dblclick();
  await g.advance(2);
  expect((await g.life()).placing?.item).toBe('scarecrow');
  expect(await g.panel()).toBeNull();
});

test('a merchant buys from your bag on a double-click', async ({ page }) => {
  await open(page);
  const g = game(page);
  await g.cmd({ t: 'grant', item: 'sunroot', n: 5 });
  await g.advance(2);
  await faceNpc(page, 'mara');
  await g.press('interact');
  await g.advance(2);
  await page.locator('.g-opts li[data-act="shop"]').click();
  await g.advance(2);
  const coins = (await g.life()).coins;
  const sunroot = page.locator('.lui-bag [data-tip="item:sunroot"]');
  await sunroot.click({ button: 'right' });
  await expect(page.locator('.ctx .ctx-i').first()).toHaveText('Sell One');
  await page.keyboard.press('Escape');
  await sunroot.dblclick();
  await g.advance(2);
  const after = await g.life();
  expect(after.bag.find((s: { item: string }) => s.item === 'sunroot')?.n).toBe(4);
  expect(after.coins).toBeGreaterThan(coins);
});

test('the minimap arrow points the way you face', async ({ page }) => {
  await open(page);
  const g = game(page);
  const { x, z } = (await page.evaluate(() => (window as any).__game.state().player)).pos;
  // Red under the centre of the minimap, where the arrow's tip is, when the arrow points that way.
  const tipRed = (dx: number, dy: number) =>
    page.evaluate(
      ([ox, oy]) => {
        const c = document.querySelector<HTMLCanvasElement>('#hud-minimap canvas')!;
        const d = c.getContext('2d')!.getImageData(c.width / 2 + ox - 2, c.height / 2 + oy - 2, 5, 5).data;
        let red = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 130 && d[i + 2] < 130) red++;
        return red;
      },
      [dx, dy] as const,
    );
  // North is up (+Z), east is right (-X): facing 0 is north, facing π south, π/2 (+X) west. The
  // arrow's body is red 6 px toward its tip; 12 px the other way is past its notched tail.
  for (const [facing, dx, dy] of [
    [0, 0, -1],
    [Math.PI, 0, 1],
    [Math.PI / 2, -1, 0],
    [-Math.PI / 2, 1, 0],
  ] as const) {
    await g.teleport(x, z, facing);
    // The minimap redraws every other frame drawn; advance() draws one.
    for (let i = 0; i < 2; i++) await g.advance(1);
    expect(await tipRed(dx * 6, dy * 6), `facing ${facing.toFixed(2)}: toward the tip`).toBeGreaterThan(10);
    expect(await tipRed(-dx * 12, -dy * 12), `facing ${facing.toFixed(2)}: behind`).toBe(0);
  }
});

test('the person you talk to looks out of the window, which starts its text below them', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const g = game(page);
  await faceNpc(page, 'hollis');
  await g.press('interact');
  // The portrait arrives a frame or two after the window opens.
  for (let i = 0; i < 40 && !(await page.locator('.mw-portrait img').count()); i++) await g.advance(1);
  const shot = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('.mw-portrait img')!;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    // Their face fills the middle: many colours, and not the dark inside of your own head.
    const d = x.getImageData(c.width * 0.3, c.height * 0.2, c.width * 0.4, c.height * 0.5).data;
    const seen = new Set<number>();
    let light = 0;
    for (let i = 0; i < d.length; i += 4) {
      seen.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
      if (d[i] + d[i + 1] + d[i + 2] > 450) light++;
    }
    return { colours: seen.size, light: light / (d.length / 4) };
  });
  console.log('npc portrait', shot);
  expect(shot.colours).toBeGreaterThan(20);
  expect(shot.light).toBeGreaterThan(0.25);

  // Nothing in the window's body sits under the medallion.
  const overlap = await page.evaluate(() => {
    const p = document.querySelector('.mw-portrait')!.getBoundingClientRect();
    const body = document.querySelector('.lui-card .mw-body') as HTMLElement;
    const first = body.firstElementChild!.getBoundingClientRect();
    return { portraitBottom: p.bottom, textTop: first.top, textLeft: first.left, portraitRight: p.right };
  });
  expect(overlap.textTop >= overlap.portraitBottom - 1 || overlap.textLeft >= overlap.portraitRight).toBe(true);
  await page.screenshot({ path: `${SHOTS}/ui-02-talk.png` });
});

/**
 * Where a story's drop cap stands against the lines beside it, in the UI's virtual px: its capitals'
 * top against the first line's, its baseline against the second line's, and its bottom against the
 * third line's top (which it must leave whole).
 */
const dropcapFit = (page: Page) =>
  page.evaluate(() => {
    const story = [...document.querySelectorAll<HTMLElement>('.q-story')].find((e) => e.offsetParent !== null)!;
    const cap = story.querySelector<HTMLElement>('.dropcap')!;
    // Boxes of no size sitting on the baselines: the cap's own, and the first line's beside it.
    const mark = () => {
      const i = document.createElement('i');
      i.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      return i;
    };
    const capMark = cap.appendChild(mark());
    const lineMark = mark();
    cap.after(lineMark);
    const capBase = capMark.getBoundingClientRect().bottom;
    const lineBase = lineMark.getBoundingClientRect().bottom;
    capMark.remove();
    lineMark.remove();
    // Capital heights in em, measured large: the canvas rounds ink to whole pixels.
    const g = document.createElement('canvas').getContext('2d')!;
    const capHeight = (s: CSSStyleDeclaration) => {
      g.font = `${s.fontWeight} 1000px ${s.fontFamily}`;
      return g.measureText('H').actualBoundingBoxAscent / 1000;
    };
    const cs = getComputedStyle(cap);
    const ss = getComputedStyle(story);
    const k = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-s'));
    const line = parseFloat(ss.lineHeight) * k;
    const capTop = capBase - capHeight(cs) * parseFloat(cs.fontSize) * k;
    const lineCapTop = lineBase - capHeight(ss) * parseFloat(ss.fontSize) * k;
    const thirdLine = story.getBoundingClientRect().top + 2 * line;
    return { scale: k, top: (capTop - lineCapTop) / k, baseline: (capBase - (lineBase + line)) / k, clear: (thirdLine - cap.getBoundingClientRect().bottom) / k };
  });

test("a story's drop cap stands from the top of its first line to the second line's baseline, at any UI scale", async ({ page }) => {
  await open(page);
  const g = game(page);
  await page.evaluate(() => document.fonts.ready);
  await faceNpc(page, 'hollis');
  await g.press('interact');
  await g.advance(3);
  // At 720p (the UI at 70%), and at 1080p with the player's own setting at its largest (136%).
  const sizes = [[1280, 720, 1], [1920, 1080, 1.3]] as const;
  for (const where of ['dialog', 'quest log']) {
    if (where === 'quest log') {
      await g.close();
      await g.press('quests');
      await g.advance(2);
    }
    await expect(page.locator('.q-story .dropcap').first()).toBeVisible();
    for (const [width, height, user] of sizes) {
      await page.evaluate((u) => localStorage.setItem('ruina.uiScale', String(u)), user);
      await page.setViewportSize({ width, height });
      await page.evaluate(() => dispatchEvent(new Event('resize')));
      const fit = await dropcapFit(page);
      const at = `${where} at ${width}x${height}, UI ${fit.scale.toFixed(2)}`;
      expect(Math.abs(fit.top), `${at}: top`).toBeLessThan(0.75);
      expect(Math.abs(fit.baseline), `${at}: baseline`).toBeLessThan(0.75);
      expect(fit.clear, `${at}: the third line is whole`).toBeGreaterThanOrEqual(0);
    }
  }
  await page.evaluate(() => localStorage.removeItem('ruina.uiScale'));
});

test('a window that closes itself after a click gives the mouse back to the camera, if the camera had it', async ({ page }) => {
  const errors = await open(page);
  const g = game(page);
  for (const [item, n] of [['sunroot', 24], ['barley', 16], ['deed.farmCart', 1]] as const) await g.cmd({ t: 'grant', item, n });
  await g.advance(2);
  // The game running on its own, so the keys go through it as they do in play.
  await page.evaluate(() => (window as any).__game.setPaused(false));
  const mouse = () => page.evaluate(() => (document.pointerLockElement ? 'camera' : 'free'));
  const capture = async () => {
    await page.mouse.click(640, 300);
    await expect.poll(mouse).toBe('camera');
  };
  /** Stays as it is for a moment (nothing asked for the mouse late). */
  const stays = async (want: string) => {
    await page.waitForTimeout(400);
    expect(await mouse()).toBe(want);
  };
  const wb = (await g.zone()).workbenches[0];
  const make = page.locator('.lui-card [data-act="make"][data-arg="pack.harvestCrate"]');

  // Packing at the workbench: talking to it (F) frees the mouse, and once the pack is made the
  // window closes and the camera has the mouse again.
  await g.teleport(wb.x, wb.z + 2, Math.PI);
  await capture();
  await page.keyboard.press('KeyF');
  await expect.poll(g.panel).toBe('craft');
  expect(await mouse()).toBe('free');
  await make.click();
  await expect.poll(g.panel).toBeNull();
  await expect.poll(mouse).toBe('camera');
  expect(await page.evaluate(() => (window as any).__game.state().player.pack)).toBeGreaterThan(0);

  // With the bag open beside the workbench, the bag stays when the workbench closes, and keeps the
  // mouse. Closing the bag yourself (Escape) leaves it free. (The pack is set down away from the
  // bench, where F would pick it up again.)
  await g.teleport(wb.x + 12, wb.z + 12, Math.PI);
  await page.keyboard.press('KeyX');
  await expect.poll(() => page.evaluate(() => (window as any).__game.state().player.pack)).toBe(0);
  await g.teleport(wb.x, wb.z + 2, Math.PI);
  await page.keyboard.press('KeyF');
  await expect.poll(g.panel).toBe('craft');
  await page.keyboard.press('KeyI');
  await expect(page.locator('.lui-bag')).toBeVisible();
  await make.click();
  await expect.poll(g.panel).toBe('bag');
  await stays('free');
  await page.keyboard.press('Escape');
  await expect.poll(g.panel).toBeNull();
  await stays('free');

  // A deed from the bag: a double-click summons the cart, the bag gets out of the way, and the
  // camera has the mouse again.
  await capture();
  await page.keyboard.press('KeyI');
  await expect.poll(g.panel).toBe('bag');
  expect(await mouse()).toBe('free');
  await page.locator('.lui-bag [data-tip="item:deed.farmCart"]').dblclick();
  await expect.poll(g.panel).toBeNull();
  await expect.poll(mouse).toBe('camera');
  await expect.poll(async () => (await g.life()).vehicles.length).toBe(1);

  // A window opened with the mouse already free leaves it free when it closes itself.
  await page.evaluate(() => document.exitPointerLock());
  await expect.poll(mouse).toBe('free');
  await page.keyboard.press('KeyV');
  await expect.poll(g.panel).toBe('garage');
  await page.locator('.lui-card [data-act="summon"]').click();
  await expect.poll(g.panel).toBeNull();
  await stays('free');
  expect(errors).toEqual([]);
});

test('on a controller, packing at the workbench still closes it and leaves the mouse alone; Menu and B open and shut the bag', async ({ page }) => {
  // A simulated Xbox controller (the browser's standard layout).
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
    (window as any).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  const errors = await open(page);
  const g = game(page);
  for (const [item, n] of [['sunroot', 12], ['barley', 8]] as const) await g.cmd({ t: 'grant', item, n });
  await g.advance(2);
  await page.evaluate(() => (window as any).__game.setPaused(false));
  const PAD = { A: 0, B: 1, Y: 3, MENU: 9, DOWN: 13 };
  const tap = async (i: number) => {
    await page.evaluate((b) => Object.assign((window as any).__pad.buttons[b], { pressed: true, value: 1 }), i);
    await page.waitForTimeout(120);
    await page.evaluate((b) => Object.assign((window as any).__pad.buttons[b], { pressed: false, value: 0 }), i);
    await page.waitForTimeout(120);
  };
  const wb = (await g.zone()).workbenches[0];
  await g.teleport(wb.x, wb.z + 2, Math.PI);
  await tap(PAD.Y);
  await expect.poll(g.panel).toBe('craft');
  // Down to the crate's Pack It, then A.
  for (let i = 0; i < 12; i++) {
    const on = await page.evaluate(() => document.querySelector('.lui-card .lui-focus')?.getAttribute('data-arg'));
    if (on === 'pack.harvestCrate') break;
    await tap(PAD.DOWN);
  }
  await tap(PAD.A);
  await expect.poll(g.panel).toBeNull();
  expect(await page.evaluate(() => (window as any).__game.state().player.pack)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await tap(PAD.MENU);
  await expect.poll(g.panel).toBe('bag');
  await tap(PAD.B);
  await expect.poll(g.panel).toBeNull();
  expect(errors).toEqual([]);
});

test('the clock sits clear of the minimap above it', async ({ page }) => {
  await open(page);
  await game(page).advance(2);
  const gap = await page.evaluate(() => {
    const studs = [...document.querySelectorAll('#hud-minimap .stud, #hud-minimap .zoom')].map((e) => e.getBoundingClientRect().bottom);
    const clock = document.querySelector('#hud-clock span')!.getBoundingClientRect().top;
    return (clock - Math.max(...studs)) / ((window as any).innerHeight / 1029);
  });
  expect(gap).toBeGreaterThan(5);
});
