// README: where skills live now, and the keys for the skill book and tree (run from the worktree root).
const fs = require('fs');
const p = 'README.md';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80));
  s = s.replace(a, b);
};
rep(
  `- \`src/skills.ts\` and \`server/src/skills.rs\`: the skill tree and its modifiers, mirrored in both
  languages. Skills are data in \`shared/tuning.json\`; adding one should not mean writing code.`,
  `- \`src/skills.ts\` and \`server/src/skills.rs\`: the skill tree, the levels skills gain by use, and the
  modifiers both apply, mirrored in both languages. The tree is data in \`shared/skilltree.json\`
  (laid out by \`tools/skilltree/gen.mjs\`), points and levels in \`shared/tuning.json\`; adding a
  skill should not mean writing code.`,
);
rep(
  `| Skill trees | T | View |`,
  `| Skill book (your skills, their levels, the hotbar) | T | View |
| Skill tree (learning) | N | A bumper, from the skill book |`,
);
fs.writeFileSync(p, s);
console.log('ok');
