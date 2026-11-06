// Fetches one asset into a fresh folder of its own, scratch/assets/<source>/<id>/ (git-ignored),
// with credit.json beside it: what it is, where it came from, who made it and its licence, and the
// line CREDITS.md needs once it goes into the game. Nothing in that folder is run or imported from
// there: it is someone else's file until it has been checked and brought in (the find-assets skill).
//
//   node tools/assets/fetch.mjs polyhaven <id> [--res 1k|2k|4k] [--maps Diffuse,nor_gl,Rough,arm,AO]
//   node tools/assets/fetch.mjs ambientcg <id> [--res 1k|2k]
//   node tools/assets/fetch.mjs sketchfab <uid>                 (needs SKETCHFAB_TOKEN)
//   node tools/assets/fetch.mjs freesound <id>                  (needs FREESOUND_API_KEY; previews)
//   node tools/assets/fetch.mjs kenney <slug>                   (a pack: kenney.nl/assets/<slug>)
//   node tools/assets/fetch.mjs itch <creator>/<game> [--file <part of a file name>]
//   node tools/assets/fetch.mjs url <https://...> --name "..." --author "..." --licence CC0 --page <https://...>

import fs from 'node:fs';
import path from 'node:path';
import { fetchAmbientCg, fetchFreesound, fetchItch, fetchKenney, fetchPolyHaven, fetchSketchfab, fetchUrl, LICENCES } from './sources.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const VALUED = ['--res', '--maps', '--file', '--name', '--author', '--licence', '--page'];
const [source, id] = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
const FETCH = {
  polyhaven: (x, out) => fetchPolyHaven(x, out, { res: opt('--res', '1k'), maps: opt('--maps')?.split(',') }),
  ambientcg: (x, out) => fetchAmbientCg(x, out, { res: opt('--res', '1k') }),
  sketchfab: (x, out) => fetchSketchfab(x, out),
  freesound: (x, out) => fetchFreesound(x, out),
  kenney: (x, out) => fetchKenney(x, out),
  itch: (x, out) => fetchItch(x, out, { file: opt('--file') }),
  url: (x, out) => fetchUrl(x, out, { name: opt('--name'), author: opt('--author'), licence: opt('--licence'), page: opt('--page') }),
};
if (!FETCH[source] || !id) {
  console.error(`usage: node tools/assets/fetch.mjs <${Object.keys(FETCH).join('|')}> <id> [options] (see the top of this file)`);
  process.exit(2);
}

// A fresh, empty folder per asset: downloads are untrusted until checked.
const safe = id
  .replace(/^https?:\/\//, '')
  .replace(/[^\w.-]+/g, '_')
  .slice(0, 80);
const out = path.join('scratch', 'assets', source, safe);
if (fs.existsSync(out) && fs.readdirSync(out).length) {
  console.error(`${out} already holds a fetch: look there, or remove it first`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const credit = await FETCH[source](id, out);
const lic = LICENCES[credit.licence];
const fileList = credit.files.map((f) => path.relative(out, f).replace(/\\/g, '/'));
const row = `| ${credit.name} | \`src/...\` (where it goes) | [${credit.source}](${credit.page}) (${id}), by ${credit.author} | ${lic ? `[${lic.name}](${lic.url})` : credit.licence} |`;
fs.writeFileSync(
  path.join(out, 'credit.json'),
  JSON.stringify({ ...credit, id, files: fileList, licenceUrl: lic?.url ?? null, fetched: new Date().toISOString().slice(0, 10), creditsRow: row }, null, 2) +
    '\n',
);

const bytes = credit.files.reduce((sum, f) => sum + (fs.existsSync(f) && fs.statSync(f).isFile() ? fs.statSync(f).size : 0), 0);
console.log(
  `${credit.name} (${credit.source}, ${lic?.name ?? credit.licence}, by ${credit.author}): ${fileList.length} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB in ${out}`,
);
for (const f of fileList.slice(0, 12)) console.log(`  ${f}`);
if (fileList.length > 12) console.log(`  ... and ${fileList.length - 12} more`);
if (!lic) console.log(`\nLicence "${credit.licence}": read it on ${credit.page} before using this; only CC0 and CC BY can go in this public repository.`);
console.log(`\nCREDITS.md, once it is in the game (fill in where):\n${row}`);
