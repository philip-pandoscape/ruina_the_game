import { expect, type Page, test } from '@playwright/test';

// The bible in a browser (/bible/, src/bible/): every page draws from the game's data without an
// error, the contents, the links between pages and the search take you where they say, and the
// Development tab is there for admins only. That every system and every thing has its page:
// tests/unit/bible.test.ts.

test.describe.configure({ mode: 'parallel' });

/** Opens the bible, telling it who is signed in (no game server runs here), and collects errors. */
async function open(page: Page, me: { admin: boolean } | null = null, at = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }));
  await page.goto(`/bible/${at}`);
  await page.waitForSelector('html[data-ready]', { timeout: 60_000 });
  return errors;
}

const go = (page: Page, path: string) => page.evaluate((h) => (location.hash = h), `#/${path}`);

test('every page of the bible draws from the game data, with its title and no error', async ({ page }) => {
  const errors = await open(page);
  await expect(page.locator('#page h1')).toHaveText('Ruina');
  const pages = await page.evaluate(() => window.__bible!.pages);
  expect(pages.length, 'a page per system, kind of thing and thing').toBeGreaterThan(300);
  // Page by page as the address changes: the bible draws a page when it hears the change, before
  // this listener (added after its own) does.
  const wrong = await page.evaluate(async (all) => {
    const out: string[] = [];
    for (const p of all) {
      const target = `#/${p.path}`;
      if (location.hash !== target) {
        const changed = new Promise((r) => addEventListener('hashchange', r, { once: true }));
        location.hash = target;
        await changed;
      }
      const h1 = document.querySelector('#page h1')?.textContent;
      if (h1 !== p.title) out.push(`${target}: titled “${h1}”`);
      if (document.querySelector('#page .missing, #page .dead')) out.push(`${target}: has holes`);
    }
    return out;
  }, pages);
  expect(wrong).toEqual([]);
  expect(errors).toEqual([]);
});

test('the contents, the links on a page and the pager take you where they say', async ({ page }) => {
  await open(page);
  await page.locator('#rail a', { hasText: 'Trade and Pack Running' }).click();
  await expect(page).toHaveURL(/#\/systems\/trade$/);
  await expect(page.locator('#page h1')).toHaveText('Trade and Pack Running');
  await expect(page.locator('#rail a.on')).toHaveText('Trade and Pack Running');

  await page.locator('#rail a', { hasText: 'Crops' }).click();
  await expect(page.locator('#page h1')).toHaveText('Crops');
  await page.locator('#page td.name a', { hasText: 'Barley' }).click();
  await expect(page).toHaveURL(/#\/crops\/barley$/);
  // An entry's own page: its explanation, its numbers, and links on to what it is made into.
  await expect(page.locator('#page .explain')).not.toBeEmpty();
  await expect(page.locator('#page dl.facts')).toContainText('Ripens here');
  await page.locator('#page dl.facts a', { hasText: 'Barley Seeds' }).click();
  await expect(page.locator('#page h1')).toHaveText('Barley Seeds');
  await expect(page.locator('#crumbs')).toContainText('Items');

  // The pager walks the list the page is in; the browser's back button comes back.
  const next = await page.locator('#pager a.next').innerText();
  await page.locator('#pager a.next').click();
  await expect(page.locator('#page h1')).toHaveText(next.split('\n').pop()!.trim());
  await page.goBack();
  await expect(page.locator('#page h1')).toHaveText('Barley Seeds');

  // An anchor on a page: a system's list of contents scrolls to its heading.
  await go(page, 'systems/farming');
  const toc = page.locator('#page .toc a').first();
  const target = (await toc.getAttribute('href'))!.split('/').pop()!;
  await toc.click();
  await expect(page.locator(`#page h2[id="${target}"]`)).toBeInViewport();

  // Somewhere that isn't a page says so.
  await go(page, 'no/such/page/here');
  await expect(page.locator('#page h1')).toHaveText('Nothing Here');
});

test('the island page draws the island as the game grows it, and a place page marks the place', async ({ page }) => {
  const errors = await open(page);
  const colours = async () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#page canvas.map[data-drawn]')!;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    });
  await go(page, 'zones/emberholm');
  await expect(page.locator('#page canvas.map[data-drawn]')).toHaveCount(1, { timeout: 30_000 });
  expect(await colours(), 'land and water in many shades, not a blank canvas').toBeGreaterThan(50);
  await go(page, 'places/windspire');
  await expect(page.locator('#page canvas.map[data-drawn]')).toHaveCount(1, { timeout: 30_000 });
  expect(await colours()).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test('search finds pages by name and by what they say, from the keyboard', async ({ page }) => {
  await open(page);
  await page.keyboard.press('/');
  await expect(page.locator('#q')).toBeFocused();
  await page.keyboard.type('barley');
  await expect(page.locator('#hits a').first()).toBeVisible();
  await expect(page.locator('#hits')).toContainText('Barley');
  await page.keyboard.press('Enter');
  await expect(page.locator('#page h1')).toContainText('Barley');
  await expect(page.locator('#hits')).toBeHidden();

  await page.locator('#q').fill('rising air');
  await expect(page.locator('#hits a')).not.toHaveCount(0);
  await page.locator('#q').fill('qqqqzzzz');
  await expect(page.locator('#hits .none')).toBeVisible();
});

test('the Development tab is there for admins only', async ({ browser }) => {
  const player = await browser.newPage();
  await open(player, { admin: false });
  await expect(player.locator('html')).toHaveAttribute('data-admin', 'false');
  await expect(player.locator('#development')).toHaveCount(0);
  await player.close();

  const admin = await browser.newPage();
  await open(admin, { admin: true });
  await expect(admin.locator('#development a', { hasText: 'Tracker' })).toHaveAttribute('href', '/design/');
  await admin.close();
});
