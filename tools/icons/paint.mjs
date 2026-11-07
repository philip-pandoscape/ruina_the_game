// Paints the icon sheets of tools/icons/catalog.mjs with Gemini (tools/images/gemini.mjs), each a
// grid of icons on a flat background that tools/icons/bake.mjs cuts out. The first sheet sets the
// style; every other sheet is painted with it as the reference, so they all match.
//   node tools/icons/paint.mjs              paints the sheets that aren't painted yet
//   node tools/icons/paint.mjs menu seeds   paints (or paints again) just these
// Each costs one Nano Banana Pro image (2K). Look at a new sheet before baking it: the painter now
// and then ignores the background colour, draws cells, or paints a different thing.
// Sheets are kept as WebP (quality 0.95, a quarter the size of Gemini's PNG and cut out the same) in
// tools/icons/sheets/<id>.webp.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { BACKGROUNDS, SHEETS, STYLE, STYLE_SHEET, gridOf } from './catalog.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const DIR = path.join(ROOT, 'tools/icons/sheets');
const sheetFile = (id) => path.join(DIR, `${id}.webp`);

function prompt(sheet, withRef) {
  const { cols, rows } = gridOf(sheet.icons.length);
  const n = sheet.icons.length;
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const lines = sheet.icons.map((ic, i) => `${i + 1}. ${ic.paint}`);
  return [
    `Paint a sprite sheet of ${words[n]} fantasy MMORPG icons arranged in a precise grid of equal square cells: ${words[rows]} rows of ${words[cols]}.`,
    withRef
      ? 'Match the attached reference sheet exactly in art style: the same brushwork, lighting, inked contour, colour palette, level of detail and size of each object in its cell. Paint only the new subjects listed below.'
      : '',
    STYLE.replace('{BG}', BACKGROUNDS[sheet.bg].css),
    `The cells, left to right and top to bottom:\n${lines.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const wanted = process.argv.slice(2);
const sheets = SHEETS.filter((s) => (wanted.length ? wanted.includes(s.id) : !fs.existsSync(sheetFile(s.id))));
if (!sheets.length) {
  console.log('every sheet is painted (name sheets to paint them again)');
  process.exit(0);
}
fs.mkdirSync(DIR, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
for (const sheet of sheets) {
  const ref = sheetFile(STYLE_SHEET);
  const withRef = sheet.id !== STYLE_SHEET && fs.existsSync(ref);
  const scratch = path.join(ROOT, 'scratch', 'sheets');
  fs.mkdirSync(scratch, { recursive: true });
  const promptFile = path.join(scratch, `${sheet.id}.txt`);
  const png = path.join(scratch, `${sheet.id}.png`);
  fs.writeFileSync(promptFile, prompt(sheet, withRef));
  const args = ['tools/images/gemini.mjs', '--out', png, '--prompt-file', promptFile, '--aspect', '1:1', '--size', '2K', ...(withRef ? ['--ref', ref] : [])];
  console.log(`painting ${sheet.id}${withRef ? ` (style from ${STYLE_SHEET})` : ''}`);
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  const webp = await page.evaluate(
    async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.95);
    },
    `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`,
  );
  fs.writeFileSync(sheetFile(sheet.id), Buffer.from(webp.split(',')[1], 'base64'));
  console.log(`  -> ${path.relative(ROOT, sheetFile(sheet.id))} (the PNG stays in ${path.relative(ROOT, png)})`);
}
await browser.close();
