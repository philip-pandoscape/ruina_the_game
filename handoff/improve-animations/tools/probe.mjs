// Runs a snippet against the gallery page and prints what it returns.
//   node handoff/improve-animations/tools/probe.mjs "<js expression using A = window.__anims>"
// e.g. "A.holdGap('row')" or "A.weaponTrack('sheathe', 0).length". Needs the dev server (GALLERY).
import { chromium } from 'playwright';

const [expr] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${process.env.GALLERY ?? 'http://localhost:5173'}/animations.html?anim=idle`);
await page.waitForFunction(() => window.__anims?.ready);
const out = await page.evaluate((e) => {
  // eslint-disable-next-line no-new-func
  return new Function('A', `return (${e});`)(window.__anims);
}, expr);
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 0));
if (errors.length) console.log('ERRORS', errors.join('\n'));
await browser.close();
