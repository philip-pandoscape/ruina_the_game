import type { Page } from '@playwright/test';
import { isTitleCase } from '../../src/ui/theme/text';

// The writing rule (design/ui.html, src/ui/theme/text.ts) as the integration tier checks it: the
// labels drawn in the open windows and the HUD, each held to Title Case. tests/integration/ui.spec.ts
// checks the game's windows with it, uiGallery.spec.ts every window of the UI gallery.

/** Every label in the open windows and the HUD that isn't in Title Case. */
export async function untitled(page: Page): Promise<string[]> {
  const labels = await page.evaluate(() => {
    const sel = [
      '.lui-btn',
      '.mw-bar',
      '.mw .h',
      '.g-opts li > span',
      '.g-opts li > small',
      '.m-tab',
      '.ctx-i',
      '.ctx-h',
      '.hud-mbtn .lbl',
      '#hint > span',
      '#lui-prompt > span:not(.key):not(.detail)',
      '.ch-slot > span',
      '.ch-stats .r > span',
      '.ql-zone > span:first-child',
      '.set-row > span',
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
