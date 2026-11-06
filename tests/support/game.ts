import type { Page } from '@playwright/test';
import type { GameApi } from '../../src/app/testApi';

// What every test that plays the game in a page shares: the game's test API, typed (window.__game,
// built in src/main.ts), and one way to open the game and wait until it's ready.

/**
 * The test API as the tests see it: what a test asks for is there (if it isn't, the test fails on
 * the spot, which is what it should do), so nothing comes back "possibly null", and nothing is
 * read-only to it. Names and arguments stay checked, so a renamed or reshaped call fails to compile.
 */
type Present<T> = T extends ArrayBufferView | ArrayBufferLike | Date | RegExp
  ? T
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Present<R>
    : T extends Promise<infer P>
      ? Promise<Present<P>>
      : T extends ReadonlyArray<unknown>
        ? { -readonly [K in keyof T]: Present<T[K]> }
        : T extends Map<infer K, infer V>
          ? Map<K, Present<V>>
          : T extends Set<infer E>
            ? Set<E>
            : T extends object
              ? { -readonly [K in keyof T]-?: Present<T[K]> }
              : NonNullable<T>;

declare global {
  interface Window {
    /** The game's test API (src/main.ts): state, stepping, commands, cameras. */
    __game: Present<GameApi>;
  }
}

/**
 * Opens the game at `url` (`/?world&test` the island offline and paused, `/?test` the yard paused,
 * `/?yard` the yard running) and waits until it's ready. Returns the console errors and page errors
 * seen from then on, for a test to expect none of.
 */
export async function openGame(page: Page, url = '/?world&test', timeout = 60_000): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await gameReady(page, timeout);
  return errors;
}

/**
 * Waits until the page plays online: the game ready, connected, a few of the server's ticks in, and
 * the island the server sent loaded.
 */
export async function onlineReady(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const o = window.__game?.online?.();
      return window.__game?.ready === true && o?.status === 'online' && o.ticks > 3 && o.lifeLoaded;
    },
    null,
    { timeout },
  );
}

/** Waits until the page's game is ready to be driven: up to `timeout` ms, or (0) as long as the test allows. */
export async function gameReady(page: Page, timeout = 0): Promise<void> {
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout });
}
