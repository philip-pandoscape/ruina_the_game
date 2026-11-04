// Renders contact sheets of hero animations from the gallery (animations.html).
//   node handoff/improve-animations/tools/shots.mjs <outDir> <id>[:view[:count[:from[:to[:height[:weapon]]]]]] ...
// Needs the dev server up (npm run dev); GALLERY overrides where it is.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [outDir, ...jobs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 420 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${process.env.GALLERY ?? 'http://localhost:5173'}/animations.html?anim=idle`);
await page.waitForFunction(() => window.__anims?.ready);
for (const job of jobs) {
  const [id, view = 'side', count = '8', from, to, h, w] = job.split(':');
  const opts = { view, count: Number(count) };
  if (from) opts.from = Number(from);
  if (to) opts.to = Number(to);
  if (h) opts.height = Number(h);
  if (w) opts.weapon = Number(w);
  const r = await page.evaluate(([i, o]) => window.__anims.sheet(i, o), [id, opts]);
  const name = `${id}-${view}${from ? `-${from}-${to}` : ''}${w ? `-w${w}` : ''}`;
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(name, JSON.stringify(r.frames));
}
if (errors.length) console.log('ERRORS', errors.join('\n'));
await browser.close();
