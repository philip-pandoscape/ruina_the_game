import { expect, test, type Page } from '@playwright/test';
import { onlineReady, openGame } from '../support/game';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The browser's shortcuts kept from it while you play (src/input/browserKeys.ts), and Full Keyboard
// (src/input/fullKeyboard.ts), in a real browser. A test's keys reach the page and never the
// browser's own shortcut handling, so what is checked is what the page does with each: kept from the
// browser (then it does nothing with it) or left to it. Ctrl+W in Full Keyboard is pressed by hand.
// Choosing a character plays online (it makes an account), so it wants the world server, as online.spec does.

interface Seen {
  type: string;
  code: string;
  button: number;
  kept: boolean;
}

/**
 * Notes whether each key and click was kept from the browser by the guard: capturing on the window
 * right after it (it's the first there), so even a window's text field that keeps its keys to itself
 * is seen.
 */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: Seen[] = [];
    (window as unknown as { __seen: Seen[] }).__seen = seen;
    for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'contextmenu', 'wheel']) {
      const note = (e: Event) => {
        seen.push({ type, code: (e as KeyboardEvent).code ?? '', button: (e as MouseEvent).button ?? -1, kept: e.defaultPrevented });
      };
      addEventListener(type, note, { capture: true });
    }
  });
}

/** What was noted since the last look. */
const seen = (page: Page): Promise<Seen[]> => page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen.splice(0));

test('in the world the browser hears none of its shortcuts, and Ctrl changes no key: Ctrl+D strafes', async ({ page }) => {
  const errors = await openGame(page);
  await watch(page);
  // Bookmark, save, reload, find, a tab by number, zoom; help, find, reload, caret browsing; back;
  // Chrome's task manager (sprinting as you close a window); Alt on its own, the browser's menu.
  const chords: Array<[string, string]> = [
    ['Control+KeyD', 'KeyD'],
    ['Control+KeyS', 'KeyS'],
    ['Control+KeyR', 'KeyR'],
    ['Control+KeyF', 'KeyF'],
    ['Control+Digit1', 'Digit1'],
    ['Control+Equal', 'Equal'],
    ['F5', 'F5'],
    ['F1', 'F1'],
    ['F3', 'F3'],
    ['F7', 'F7'],
    ['Alt+ArrowLeft', 'ArrowLeft'],
    ['Shift+Escape', 'Escape'],
    ['Alt', 'AltLeft'],
  ];
  for (const [chord] of chords) await page.keyboard.press(chord);
  const downs = (await seen(page)).filter((e) => e.type === 'keydown');
  for (const [chord, code] of chords) expect([chord, downs.find((e) => e.code === code)?.kept]).toEqual([chord, true]);
  // The first Ctrl in a tab says, once, where Ctrl+W is kept too: a tab never hands it over.
  await expect(page.locator('#lui-toasts')).toContainText('Ctrl+W closes the game before it hears the key');
  // The game's own keys are the game's: W is no shortcut.
  await page.keyboard.press('KeyW');
  expect((await seen(page)).find((e) => e.type === 'keydown' && e.code === 'KeyW')?.kept).toBe(false);

  // Ctrl held, D still strafes (and W still walks: in Full Keyboard Ctrl+W comes to the game).
  const before = await page.evaluate(() => window.__game.state().player.pos);
  await page.keyboard.down('Control');
  await page.keyboard.down('KeyD');
  await page.evaluate(() => window.__game.advanceLive(30, false));
  await page.keyboard.up('KeyD');
  await page.keyboard.up('Control');
  const after = await page.evaluate(() => window.__game.state().player.pos);
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('a text field keeps its own keys, and the browser still gets none of its shortcuts', async ({ page }) => {
  await openGame(page);
  // A field like a window's (the skill tree's search, a party invite).
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'field';
    field.addEventListener('keydown', (e) => e.stopPropagation()); // as the windows' fields do: typing isn't playing
    document.body.append(field);
    field.focus();
  });
  await watch(page);
  await page.keyboard.type('a ruin/s');
  await page.keyboard.press('Control+KeyA');
  await page.keyboard.press('Control+KeyD');
  await page.keyboard.press('F5');
  const downs = (await seen(page)).filter((e) => e.type === 'keydown');
  expect(downs.find((e) => e.code === 'Slash')?.kept).toBe(false); // Firefox's quick find, but typing here
  expect(downs.find((e) => e.code === 'KeyA' && e.kept)).toBeUndefined(); // select all
  expect(downs.find((e) => e.code === 'KeyD')?.kept).toBe(true); // bookmark
  expect(downs.find((e) => e.code === 'F5')?.kept).toBe(true); // reload
  expect(await page.inputValue('#field')).toBe('a ruin/s');
  // Select all then a letter: the field's own select all worked.
  await page.keyboard.press('Control+KeyA');
  await page.keyboard.type('x');
  expect(await page.inputValue('#field')).toBe('x');
});

/** Whether the page is in full screen. */
const fullScreen = (page: Page) => page.evaluate(() => !!document.fullscreenElement);
/** Full Keyboard's setting as this browser keeps it. */
const setting = (page: Page) => page.evaluate(() => localStorage.getItem('ruina.fullKeyboard'));
/** A test's browser starts with Full Keyboard off (src/input/fullKeyboard.ts): a player's is on. */
const asAPlayer = (page: Page) => page.addInitScript(() => localStorage.setItem('ruina.fullKeyboard', 'on'));

test('F11 goes into Full Keyboard and out again there and then, leaving the setting alone', async ({ page }) => {
  await openGame(page);
  await watch(page);
  await page.keyboard.press('F11');
  await expect.poll(() => fullScreen(page)).toBe(true);
  expect((await seen(page)).find((e) => e.type === 'keydown' && e.code === 'F11')?.kept).toBe(true);
  await page.keyboard.press('F11');
  await expect.poll(() => fullScreen(page)).toBe(false);
  expect(await setting(page)).toBeNull();
});

test('Full Keyboard comes on by itself: a click into the game goes in, again after stepping out, until Settings turns it off', async ({ page }) => {
  await asAPlayer(page);
  await openGame(page);
  const game = { x: 640, y: 360 };
  await page.mouse.click(game.x, game.y);
  await expect.poll(() => fullScreen(page)).toBe(true);
  // Escape held (the browser's way out): out, the game says how to go back, and a click goes back in.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => fullScreen(page)).toBe(false);
  await expect(page.locator('#lui-toasts')).toContainText('Out of full screen: a click on the game goes back in');
  await page.mouse.click(game.x, game.y);
  await expect.poll(() => fullScreen(page)).toBe(true);
  // Settings turns it off: out at once, and a click into the game stays out, in this browser from now on.
  await page.evaluate(() => {
    window.__game.pressLife('settings');
    window.__game.advance(2);
  });
  await page.getByRole('button', { name: 'Turn Full Keyboard Off' }).click();
  await expect.poll(() => fullScreen(page)).toBe(false);
  expect(await setting(page)).toBe('off');
  await page.evaluate(() => window.__game.advance(2));
  await page.getByRole('button', { name: 'Turn Full Keyboard On' }).click();
  await expect.poll(() => fullScreen(page)).toBe(true);
  expect(await setting(page)).toBe('on');
});

test('choosing a character goes into the world in Full Keyboard', async ({ page }) => {
  await asAPlayer(page);
  const name = `keys${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 20);
  await page.goto('/?bugs=0');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill('lantern-light-42');
  await page.getByLabel('Confirm Password').fill('lantern-light-42');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.locator('.cs-row.sel')).toContainText(name);
  await page.getByRole('button', { name: 'Enter World' }).click();
  await onlineReady(page);
  expect(await fullScreen(page)).toBe(true);
});

test('in a tab, leaving asks first while Ctrl is held (Ctrl+W), and never otherwise', async ({ page }) => {
  await openGame(page);
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.type());
    void d.dismiss(); // stay
  });
  // A key first: a browser asks only on a page someone has used.
  await page.keyboard.press('Digit9');
  await page.evaluate(() => {
    (window as unknown as { __stayed: boolean }).__stayed = true;
  });
  await page.keyboard.down('Control');
  // What Ctrl+W does in a tab: the browser goes to close the page without the page hearing the W.
  await page.evaluate(() => location.reload()).catch(() => {});
  expect(asked).toEqual(['beforeunload']);
  expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(true);
  // Ctrl up: a reload (an update to the game, the browser's button) goes without asking.
  await page.keyboard.up('Control');
  await page.reload();
  expect(asked).toEqual(['beforeunload']);
  expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBeUndefined();
});

test("the mouse: back stays in the game, a right click opens no menu, Ctrl+wheel doesn't zoom the page", async ({ page }) => {
  await openGame(page);
  await watch(page);
  const url = page.url();
  const box = { x: 640, y: 360 };
  // A right click on the HUD (a part of it of the test's own, over the game: the canvas takes the
  // mouse for the camera on a click, and a captured mouse opens no menu anyway).
  await page.evaluate(() => {
    const plate = document.createElement('div');
    plate.style.cssText = 'position:fixed;left:0;top:0;width:60px;height:60px;z-index:99999';
    document.body.append(plate);
  });
  await page.mouse.click(20, 20, { button: 'right' });
  // The mouse's back button (Playwright's mouse has no such button: the browser's own input does).
  const cdp = await page.context().newCDPSession(page);
  for (const type of ['mousePressed', 'mouseReleased'] as const) await cdp.send('Input.dispatchMouseEvent', { type, ...box, button: 'back', clickCount: 1 });
  await page.mouse.click(box.x, box.y, { button: 'middle' });
  await page.mouse.move(box.x, box.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 240);
  await page.keyboard.up('Control');
  const got = await seen(page);
  expect(got.find((e) => e.type === 'mouseup' && e.button === 3)?.kept).toBe(true);
  expect(got.find((e) => e.type === 'contextmenu')?.kept).toBe(true);
  expect(got.find((e) => e.type === 'mousedown' && e.button === 1)?.kept).toBe(true);
  expect(got.find((e) => e.type === 'wheel')?.kept).toBe(true);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.__game.ready)).toBe(true);
});
