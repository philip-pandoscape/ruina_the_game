// design/status.json: the UI restyle, the skill book and tree, points and levels (run from the worktree root).
const fs = require('fs');
const p = 'design/status.json';
const raw = fs.readFileSync(p, 'utf8');
const s = JSON.parse(raw);
const feature = (title) => {
  const f = s.features.find((x) => x.title === title);
  if (!f) throw new Error('no feature ' + title);
  return f;
};

Object.assign(feature('Open-world HUD'), {
  notes:
    'In the Parchment & Timber look: your portrait and name, health and labor bars with the purse, a round minimap with zoom and quest marks, the clock and wind, a compass, the quest scroll with progress bars, menu buttons with their keys, the interaction prompt, toasts, place banners and name plates.',
  files: ['src/ui/life/lifeUI.ts', 'src/ui/theme/hud.css', 'src/ui/theme/theme.css'],
});
Object.assign(feature('Panels'), {
  notes:
    'MMO windows docked at the sides, open while you walk (walking away from whoever you are talking to closes theirs): talking lists their quests and what they offer; quests have offer, progress and hand-in pages with objectives and rewards; the merchant has Buy and Sell tabs beside your bag; workbench, storage, vehicles; a character window (P) with gear slots around a live picture of you; a two-pane quest log with milestones; the map; settings (UI size, credits); the developer panel (backquote). Portraits come from the live scene; items, slots and rewards have tooltips.',
  files: ['src/ui/life/lifeUI.ts', 'src/ui/theme/windows.css', 'src/ui/theme/tooltip.ts', 'src/render/portrait.ts'],
});
Object.assign(feature('Controller navigation in panels'), {
  notes:
    'With a window open the D-pad or stick (or the arrow keys) moves a highlight over its buttons, A (Enter) presses the highlighted one and B (Escape) closes. On a controller an open window has the pad: you stand still and its D-pad no longer calls the mount or opens the map. The skill book and tree have their own cursor (View opens the book, a bumper turns to the tree).',
});
Object.assign(feature('Classless skill trees and hotbar'), {
  title: 'Skill tree and skill book',
  notes:
    'The tree (N) is a chart of 226 nodes: four disciplines around you, each with its weapon next to you and its skills along a spine, and passives, notables and keystones between them, every one a modifier the rules already apply. You learn outward from what you know: click to plan the way to a node, Learn to spend the points, right-click to give one back (and whatever only it held up). The book (T) lists every weapon, ability and movement skill with its level, experience and numbers, and is where you equip a weapon and fill the hotbar and the Q / E keys. The fifteen old skills kept their places, links and costs, so saved builds still mean the same.',
  files: ['src/skills.ts', 'src/build.ts', 'src/ui/skills/panel.ts', 'src/ui/skills/book.ts', 'src/ui/skills/tree.ts', 'shared/skilltree.json', 'tools/skilltree/gen.mjs', 'server/src/skills.rs'],
});

const add = (f) => {
  if (!s.features.some((x) => x.title === f.title)) s.features.push(f);
};
add({
  system: 'ui',
  status: 'done',
  title: 'Parchment & Timber look',
  notes:
    'Parchment panels in timber frames with brass trim and rivets, two bundled typefaces (TeX Gyre Pagella, Alegreya SC) and 16-pixel icons for every item, ability and badge, redrawn from Twemoji by tools/icons/bake.mjs (npm run icons). CREDITS.md and the Settings window name the sources.',
  files: ['src/ui/theme/theme.css', 'src/ui/theme/pixelIcons.ts', 'src/ui/theme/icons.ts', 'tools/icons/bake.mjs', 'CREDITS.md'],
});
add({
  system: 'ui',
  status: 'done',
  title: 'A UI that scales with the window',
  notes: 'Laid out for a screen 1029 px tall and scaled to the window, so it keeps its size relative to the screen at any resolution; Settings has a UI size slider on top of that.',
  files: ['src/ui/theme/scale.ts'],
});
add({
  system: 'combat',
  status: 'done',
  title: 'Skill points from quests and milestones',
  notes:
    'No levels: you start with 2 points (skills.startPoints) and every quest and milestone you finish gives more (rewards.skillPoints: 21 from the thirteen quests, 8 from the milestones). They are counted from the quests you have done rather than kept, so islands saved before they existed have theirs too. The server checks every build against them; the training yard and the battlefield allow skills.points.',
  files: ['shared/quests.json', 'src/sim/life/progress.ts', 'server/src/life/quests.rs'],
});
add({
  system: 'combat',
  status: 'done',
  title: 'Skills level by use',
  notes:
    'Each weapon gains experience for every hit it lands, each ability for every cast, each movement skill for every use, and levels up along tuning.json skills.levels (ten levels). A level adds a little to what it does (damage, healing, quicker recovery), the island keeps the experience, and the server counts it online. A level-up says so and counts toward the Practised Hand milestone.',
  files: ['shared/tuning.json', 'src/sim/life/progress.ts', 'src/skills.ts', 'server/src/skills.rs'],
});
add({
  system: 'quests',
  status: 'done',
  title: 'Milestones',
  notes:
    'Quests with nobody to hand them to: they start when their prerequisites are done and finish the moment their steps are, each worth a skill point. Green Thumb (30 harvests), Sky Legs (two minutes gliding), Pack Mule (5 deliveries), Rancher (3 animals), Contract Hand (5 contracts), Wayfarer (every corner of the island), Slime Hunter (15 slimes) and Practised Hand (5 skill levels). The quest log has a part for them; the quest scroll leaves them out.',
  files: ['shared/quests.json', 'src/sim/life/quests.ts'],
});

s.next = [
  ...(s.next ?? []),
  'Skills, next: balance the tree (its numbers are first guesses: a keystone is 8 to 13 points from nothing, Emberholm gives 31 in all); notables and keystones that do new things, not only bigger numbers; life skills (farming, crafting, sailing) that level by use the same way.',
];
s.questions = [
  ...(s.questions ?? []),
  {
    q: 'Which quests and milestones should give skill points, and how many?',
    context:
      'Picked for now: every quest 1 to 3 (the long ones, Home and Shipwright, 3), every milestone 1, and 2 to start: 31 points on Emberholm for a 226-node tree. Fewer makes each choice weigh more; more lets a player try two disciplines on the starter isle.',
  },
];
s.sessions = [
  ...(s.sessions ?? []),
  {
    date: '2026-11-04',
    title: 'Parchment & Timber, the skill book and the skill tree',
    summary:
      'The whole UI in the look chosen from three rounds of prototypes, MMO windows docked at the sides, and skills in two parts: a large tree to learn from, with points from quests and milestones, and a book of the skills you use, which level up as you use them.',
    points: [
      'src/ui/theme: the look, the scaled UI (with a size setting), pixel icons for everything and live portraits; src/ui/life/lifeUI.ts redone as docked windows, with a character window and a two-pane quest log.',
      'shared/skilltree.json (laid out by tools/skilltree/gen.mjs): 226 nodes in four disciplines, learned outward through their links; the old skills kept their places and costs.',
      'Skill points are startPoints plus the skillPoints of finished quests and milestones; experience lives with the island, counted by the server online; levels feed the same modifier fold as the tree, in TypeScript and Rust together.',
      'Input: an open window has the controller, the press that closes a window is not also a game press, and the skill book (T, View) and tree (N, a bumper) have their own cursor.',
      'The browser and the server agree on getting better: a place reached counts for each quest by its own reach and height (both rules); a hit trains the weapon that landed it, so an arrow trains its bow and a blast nothing; only a kill is a defeat, not a piece dissolving; a build is held to the points the island has earned.',
    ],
  },
];
s.updated = '2026-11-04';
fs.writeFileSync(p, JSON.stringify(s, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
console.log('ok', s.features.length, 'features');
