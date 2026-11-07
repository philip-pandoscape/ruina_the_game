import { expect, test, type Page } from '@playwright/test';
import { UI_ENTRIES } from '../../src/dev/ui/entries';
import { untitled } from '../support/labels';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

// The UI gallery (/dev/ui.html, src/dev/ui/): every window of the interface in each of its made-up
// states (src/dev/ui/entries.ts), made up on an offline island without an error, drawn, and in Title
// Case where it labels things; and the content library framing it (#/ui/<window>/<state>). That every
// entry is made up somewhere is a unit test (tests/unit/uiGallery.test.ts). The screenshots in
// screenshots/ are for a human.

/** What the page says of itself (src/dev/ui/main.ts). */
interface Ui {
  ready: boolean;
  entry: string | null;
  error: string | null;
}

/** Where each window draws: an entry's own, or else its window's. */
const DRAWN: Record<string, string> = {
  bag: '.lui-bag',
  character: '.lui-card',
  quests: '.lui-card',
  map: '.lui-card',
  rides: '.lui-card',
  settings: '.lui-card',
  developer: '.lui-card',
  admin: '.lui-card',
  talk: '.lui-card',
  shop: '.lui-card',
  crafting: '.lui-card',
  storage: '.lui-card',
  skills: '#skills',
  challenge: '#mg-challenge',
  challenged: '#mg-invite',
  table: '#mg-game',
  'party/frame': '#hud-party',
  'party/window': '#party-win',
  'party/invited': '#party-invite',
  channels: '#channels-win',
  'channels/moved': '#hud-channel',
};

const keyOf = (e: { window: string; state: string }) => `${e.window}/${e.state}`;
const drawn = (key: string): string | undefined => DRAWN[key] ?? DRAWN[key.split('/')[0]];

/** Opens the entry `key` names and waits until it is made up; returns the errors the page has seen. */
async function show(page: Page, key: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/dev/ui.html#/${key}`);
  await page.waitForFunction(() => (window as unknown as { __ui?: Ui }).__ui?.ready === true, null, { timeout: 90_000 });
  return errors;
}

test('every entry has a window to look for', () => {
  expect(UI_ENTRIES.filter((e) => !drawn(keyOf(e))).map(keyOf)).toEqual([]);
});

for (const e of UI_ENTRIES) {
  const key = keyOf(e);
  test(`${key}: made up on the island, drawn, and labelled in Title Case`, async ({ page }) => {
    const errors = await show(page, key);
    const ui = await page.evaluate(() => (window as unknown as { __ui: Ui }).__ui);
    expect(ui.entry).toBe(key);
    expect(ui.error).toBeNull();
    await expect(page.locator(drawn(key) as string)).toBeVisible();
    expect(await untitled(page)).toEqual([]);
    await page.screenshot({ path: `screenshots/ui-${e.window}-${e.state}.png` });
    expect(errors).toEqual([]);
  });
}

test('with no entry named, the page lists every one', async ({ page }) => {
  await page.goto('/dev/ui.html');
  const links = page.locator('.gal-list a');
  await expect(links).toHaveCount(UI_ENTRIES.length);
  expect(await links.evaluateAll((a) => a.map((x) => x.getAttribute('href')))).toEqual(UI_ENTRIES.map((e) => `#/${keyOf(e)}`));
});

test('the content library lists every entry and frames the one it opens', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/dev/library.html?test#/ui/bag/full');
  type Lib = {
    ready: boolean;
    subjects(): Array<{ id: string; anims: Array<{ id: string }> }>;
    state(): { subject: string; anim: string; gallery: boolean; ready: boolean };
    gallery(): { error(): string | null } | null;
  };
  await page.waitForFunction(() => (window as unknown as { __library?: { ready: boolean } }).__library?.ready === true, null, { timeout: 90_000 });
  const listed = await page.evaluate(() =>
    (window as unknown as { __library: Lib }).__library
      .subjects()
      .find((s) => s.id === 'ui')
      ?.anims.map((a) => a.id),
  );
  expect(listed).toEqual(UI_ENTRIES.map(keyOf));
  await page.waitForFunction(() => (window as unknown as { __library: Lib }).__library.state().ready, null, { timeout: 90_000 });
  const state = await page.evaluate(() => {
    const L = (window as unknown as { __library: Lib }).__library;
    return { ...L.state(), error: L.gallery()?.error() };
  });
  expect(state).toMatchObject({ subject: 'ui', anim: 'bag/full', gallery: true, ready: true, error: null });
  await expect(page.frameLocator('.gallery iframe').locator('.lui-bag')).toBeVisible();
  await page.locator('.gallery').screenshot({ path: 'screenshots/library-ui.png' });
  expect(errors).toEqual([]);
});
