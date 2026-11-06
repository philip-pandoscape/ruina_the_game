// Searches the free asset sources that have an API (the find-assets skill,
// .claude/skills/find-assets/SKILL.md) and lists candidates with their licence, author, size and a
// preview, newest-best first. Then says where else to look by hand for that kind of thing.
//
//   node tools/assets/search.mjs model "wooden barrel"
//   node tools/assets/search.mjs texture "mossy stone" --limit 10
//   node tools/assets/search.mjs sky "sunset"
//   node tools/assets/search.mjs sound "sword hit"              (needs FREESOUND_API_KEY)
//   node tools/assets/search.mjs animation "sword attack"       (Sketchfab, animated)
//   ... --source polyhaven,sketchfab   --licence by (CC BY too, Sketchfab)   --faces 20000 (Sketchfab;
//   60000 by default, which leaves out museum scans)   --json
//
// Fetch one with tools/assets/fetch.mjs <source> <id>.

import { searchAmbientCg, searchFreesound, searchPolyHaven, searchSketchfab } from './sources.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--source', '--limit', '--licence', '--faces'].includes(args[i - 1]));
const [kind, ...queryWords] = positional;
const query = queryWords.join(' ');
const KINDS = ['model', 'texture', 'sky', 'sound', 'music', 'animation'];
if (!KINDS.includes(kind) || !query) {
  console.error(`usage: node tools/assets/search.mjs <${KINDS.join('|')}> "<words>" [--source a,b] [--limit n] [--licence by] [--json]`);
  process.exit(2);
}
const limit = Number(opt('--limit', 6));

const DEFAULT_SOURCES = {
  model: ['polyhaven', 'sketchfab'],
  texture: ['polyhaven', 'ambientcg'],
  sky: ['polyhaven'],
  sound: ['freesound'],
  music: ['freesound'],
  animation: ['sketchfab'],
};
const sources = (opt('--source') ?? DEFAULT_SOURCES[kind].join(',')).split(',');
const SEARCH = {
  polyhaven: (k, q, n) => searchPolyHaven(k, q, n),
  ambientcg: (k, q, n) => searchAmbientCg(k, q, n),
  sketchfab: (k, q, n) => searchSketchfab(k, q, n, { licence: opt('--licence', 'cc0'), maxFaces: Number(opt('--faces', 60000)) }),
  freesound: (k, q, n) => searchFreesound(k, q, n),
};

// Where to look by hand: no API, or no scripted search.
const BY_HAND = {
  model: [
    'Quaternius (CC0, stylized, whole packs): https://quaternius.com/  (fetch: itch quaternius/<pack>)',
    'Kenney (CC0, low-poly): https://kenney.nl/assets?q=3d  (fetch: kenney <slug>)',
    'OpenGameArt (check each licence; no scripted fetch): https://opengameart.org/art-search-advanced?field_art_type_tid[]=10',
  ],
  texture: ['OpenGameArt textures: https://opengameart.org/art-search-advanced?field_art_type_tid[]=9'],
  sky: ['ambientCG skies (HDRIs): https://ambientcg.com/list?type=hdri'],
  sound: [
    'Kenney audio packs (CC0: impacts, UI, RPG, interface): https://kenney.nl/assets?q=audio  (fetch: kenney <slug>)',
    'OpenGameArt sound effects: https://opengameart.org/art-search-advanced?field_art_type_tid[]=13',
    'Paid, last: ElevenLabs sound effects from a description (ELEVEN_LABS_API_KEY is in .env; say the cost first)',
  ],
  music: [
    'OpenGameArt music (CC0 / CC BY only): https://opengameart.org/art-search-advanced?field_art_type_tid[]=12',
    'Kevin MacLeod, incompetech (CC BY 4.0): https://incompetech.com/music/royalty-free/music.html',
  ],
  animation: [
    "Quaternius' Universal Animation Library 1 and 2 (CC0): fetch itch quaternius/universal-animation-library and quaternius/universal-animation-library-2",
    "Meshy's animation library on our hero's own skeleton: meshy_list_animations (free to look; 3 credits a clip, say so first)",
    "Mixamo (Adobe account, the user's hands; never commit raw Mixamo files: the repository is public)",
  ],
};

const results = [];
for (const s of sources) {
  const search = SEARCH[s];
  if (!search) {
    console.warn(`unknown source ${s} (${Object.keys(SEARCH).join(', ')})`);
    continue;
  }
  try {
    results.push(...(await search(kind, query, limit)));
  } catch (e) {
    console.warn(`  ${s}: ${e.message}`);
  }
}

if (args.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const s of sources) {
    const mine = results.filter((r) => r.source === s);
    console.log(`\n== ${s}: ${mine.length} for "${query}"`);
    for (const r of mine) {
      console.log(`  ${r.id}  ${r.name}  [${r.licence}]  by ${r.author || '?'}`);
      console.log(`      ${r.detail}`);
      console.log(`      ${r.page}`);
      if (r.preview) console.log(`      preview: ${r.preview}`);
    }
  }
  console.log(`\nAlso look by hand:\n${(BY_HAND[kind] ?? []).map((l) => `  - ${l}`).join('\n')}`);
  console.log('\nFetch one: node tools/assets/fetch.mjs <source> <id>   (into scratch/assets/, with its credit)');
}
