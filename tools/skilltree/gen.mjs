// Lays out the skill tree in shared/skilltree.json: four disciplines around you, each with its
// weapon next to you, its skills along a spine running outward, and passives, notables and
// keystones on the orbits between. Run it to lay the tree out again (npm run skilltree); the result
// is data, and can be edited by hand after that.
//
// The skills themselves (what they're called, grant and change) are read back from the file, so
// laying it out again never loses an edit to them. The order of `nodes` is what a saved build's
// bits mean: the fifteen skills keep the places they had before the tree grew, and everything else
// follows them. Lay the tree out again only before anyone has spent points in the new places.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'shared/skilltree.json');
const tuning = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/tuning.json'), 'utf8'));
const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;

// The fifteen skills, in the order saved builds know them by.
const SKILL_FIELDS = ['id', 'kind', 'tree', 'name', 'desc', 'icon', 'tags', 'grants', 'mods'];
const pick = (n) => Object.fromEntries(SKILL_FIELDS.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]));
const SKILLS = (previous ? previous.nodes.filter((n) => n.kind === 'skill') : tuning.skills.nodes.map((n) => ({ ...n, kind: 'skill' }))).map(pick);

// ---------- Layout ----------

const RADII = [128, 196, 266, 338, 412, 488, 566, 646];
const MIDS = [-45, 45, 135, -135]; // where each discipline points, degrees clockwise from up
const BRIDGES = new Set([3, 6]); // the orbits that cross from one discipline into the next
// Each skill's place: discipline, orbit, steps along the orbit from the spine.
const PLAN = [
  [0, 0, 0, 'sword'], [0, 1, 0, 'cleave'], [0, 2, 0, 'whirlwind'], [0, 1, 2, 'dodgeRoll'],
  [1, 0, 0, 'club'], [1, 1, 0, 'heal'], [1, 2, 0, 'swiftMending'], [1, 1, 2, 'block'],
  [2, 0, 0, 'staff'], [2, 1, 0, 'meteor'], [2, 2, 0, 'quickIncantation'],
  [3, 0, 0, 'bow'], [3, 1, 0, 'rapidFire'], [3, 2, 0, 'piercing'], [3, 1, -2, 'backstep'],
];
// Each skill touches the one it needed before the tree grew, so those builds cost what they did.
const PARENT = {
  cleave: 'sword', whirlwind: 'cleave', dodgeRoll: 'sword',
  heal: 'club', swiftMending: 'heal', block: 'club',
  meteor: 'staff', quickIncantation: 'meteor',
  rapidFire: 'bow', piercing: 'rapidFire', backstep: 'bow',
};
const ROOTS = new Set(['sword', 'club', 'staff', 'bow']); // learnable with nothing else learned

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- What the nodes do ----------
// Every effect is a modifier the rules already apply (shared/tuning.json "stats").

const dmg = (value, f) => ({ stat: 'attack.damage', op: 'inc', value, ...f });
const speed = (value, f) => ({ stat: 'attack.startup', op: 'more', value: -value, ...f });
const slower = (value, f) => ({ stat: 'attack.startup', op: 'more', value, ...f });
const heal = (value) => ({ stat: 'ability.amount', op: 'inc', value, skill: 'heal' });
const area = (value, f) => ({ stat: 'ability.radius', op: 'inc', value, ...f });
const spell = (value, f) => ({ stat: 'ability.damage', op: 'inc', value, ...f });
const cast = (value, f) => ({ stat: 'cast.frames', op: 'more', value: -value, ...f });
const castSlower = (value, f) => ({ stat: 'cast.frames', op: 'more', value, ...f });
const cooldown = (value, f) => ({ stat: 'ability.cooldown', op: 'more', value: -value, ...f });
const cooldownLonger = (value, f) => ({ stat: 'ability.cooldown', op: 'more', value, ...f });
const recover = (value, skill) => ({ stat: 'movement.cooldown', op: 'more', value: -value, skill });
// The dodges have no cooldown: they cost stamina, and these make them cost less.
const lighter = (value, skill) => ({ stat: 'movement.stamina', op: 'more', value: -value, skill });
const targets = (value, weapon) => ({ stat: 'melee.maxTargets', op: 'flat', value, weapon });
const pierce = (value) => ({ stat: 'projectile.pierce', op: 'flat', value, weapon: 3 });
const SWORD = { weapon: 0 };
const CLUB = { weapon: 1 };
const STAFF = { weapon: 2 };
const BOW = { weapon: 3 };
const MELEE = { tags: ['melee'] };
const RANGED = { tags: ['ranged'] };
const FIRE = { tags: ['fire'] };
const SPELLS = { tags: ['spell'] };
const WEAPONS = { tags: ['attack'] };
const HEAL = { skill: 'heal' };
const METEOR = { skill: 'meteor' };

const DISCIPLINES = [
  {
    small: [
      { name: 'Sword Damage', mods: [dmg(0.04, SWORD)] },
      { name: 'Sword Speed', mods: [speed(0.04, SWORD)] },
      { name: 'Melee Damage', mods: [dmg(0.03, MELEE)] },
      { name: 'Footwork', mods: [lighter(0.05, 'dodgeRoll')] },
    ],
    notable: [
      { name: 'Keen Edge', icon: '⚔️', mods: [dmg(0.12, SWORD)] },
      { name: 'Riposte', icon: '🤺', mods: [speed(0.08, SWORD), dmg(0.04, SWORD)] },
      { name: 'Wide Arc', icon: '🌪️', mods: [targets(1, 0), dmg(0.04, SWORD)] },
      { name: 'Iron Wrists', icon: '💪', mods: [speed(0.06, MELEE)] },
      { name: "Duelist's Step", icon: '👣', mods: [lighter(0.2, 'dodgeRoll')] },
      { name: 'Blade Dancer', icon: '🍃', mods: [dmg(0.08, SWORD), lighter(0.1, 'dodgeRoll')] },
      { name: 'Heavy Swing', icon: '💥', mods: [dmg(0.15, MELEE), slower(0.05, MELEE)] },
      { name: 'Steel Nerves', icon: '⛓️', mods: [dmg(0.1, MELEE)] },
    ],
    keystone: [
      { name: 'Bladestorm', icon: '🌟', mods: [dmg(0.35, SWORD), slower(0.2, SWORD)] },
      { name: 'Whirling Steel', icon: '🎖️', mods: [targets(2, 0), dmg(-0.15, SWORD)] },
    ],
  },
  {
    small: [
      { name: 'Healing', mods: [heal(0.06)] },
      { name: 'Club Damage', mods: [dmg(0.04, CLUB)] },
      { name: 'Healing Reach', mods: [area(0.05, HEAL)] },
      { name: 'Steady Guard', mods: [recover(0.05, 'block')] },
    ],
    notable: [
      { name: 'Warm Hands', icon: '🤲', mods: [heal(0.15)] },
      { name: "Mender's Grace", icon: '🕊️', mods: [cast(0.12, HEAL)] },
      { name: 'Shepherd', icon: '🐑', mods: [area(0.2, HEAL)] },
      { name: 'Deep Roots', icon: '🌳', mods: [cooldown(0.15, HEAL)] },
      { name: 'Bastion', icon: '🏰', mods: [recover(0.25, 'block')] },
      { name: 'Rally', icon: '📯', mods: [heal(0.1), dmg(0.06, CLUB)] },
      { name: 'Soothing Rain', icon: '🌧️', mods: [area(0.12, HEAL), heal(0.06)] },
      { name: 'Herbalist', icon: '🌿', mods: [dmg(0.12, CLUB)] },
    ],
    keystone: [
      { name: 'Lifebinder', icon: '🧿', mods: [heal(0.45), dmg(-0.25, WEAPONS)] },
      { name: 'Sanctuary', icon: '💠', mods: [area(0.4, HEAL), cooldownLonger(0.25, HEAL)] },
    ],
  },
  {
    small: [
      { name: 'Fire Damage', mods: [spell(0.05, FIRE)] },
      { name: 'Casting Speed', mods: [cast(0.04, SPELLS)] },
      { name: 'Fire Reach', mods: [area(0.06, FIRE)] },
      { name: 'Staff Damage', mods: [dmg(0.04, STAFF)] },
    ],
    notable: [
      { name: 'Kindling', icon: '🔥', mods: [spell(0.15, FIRE)] },
      { name: 'Ember Heart', icon: '🌋', mods: [cooldown(0.15, METEOR)] },
      { name: 'Ash and Cinder', icon: '🌫️', mods: [spell(0.1, FIRE), area(0.08, FIRE)] },
      { name: 'Wildfire', icon: '🎇', mods: [area(0.2, FIRE)] },
      { name: 'Focused Mind', icon: '🧠', mods: [cast(0.1, SPELLS)] },
      { name: 'Searing Heat', icon: '☀️', mods: [spell(0.12, FIRE)] },
      { name: 'Candlewick', icon: '🕯️', mods: [dmg(0.1, STAFF)] },
      { name: 'Meteor Shower', icon: '🌠', mods: [cooldown(0.1, METEOR), spell(0.06, FIRE)] },
    ],
    keystone: [
      { name: 'Glass Cannon', icon: '🔮', mods: [spell(0.5, SPELLS), castSlower(0.25, SPELLS)] },
      { name: 'Pyreborn', icon: '🐉', mods: [spell(0.3, FIRE), { stat: 'ability.amount', op: 'inc', value: -0.2, tags: ['heal'] }] },
    ],
  },
  {
    small: [
      { name: 'Arrow Damage', mods: [dmg(0.04, BOW)] },
      { name: 'Draw Speed', mods: [speed(0.04, BOW)] },
      { name: 'Nimble', mods: [lighter(0.05, 'backstep')] },
      { name: 'Ranged Damage', mods: [dmg(0.03, RANGED)] },
    ],
    notable: [
      { name: 'Steady Aim', icon: '🎯', mods: [dmg(0.12, BOW)] },
      { name: 'Fletcher', icon: '🪶', mods: [pierce(1)] },
      { name: 'Quick Draw', icon: '⏱️', mods: [speed(0.1, BOW)] },
      { name: 'Hawk Eye', icon: '🦅', mods: [dmg(0.08, BOW), pierce(1)] },
      { name: 'Light Feet', icon: '🐾', mods: [lighter(0.25, 'backstep')] },
      { name: "Hunter's Mark", icon: '🦌', mods: [dmg(0.1, RANGED)] },
      { name: 'Volley', icon: '🎆', mods: [speed(0.06, BOW), dmg(0.05, BOW)] },
      { name: 'Wind Reader', icon: '🌬️', mods: [dmg(0.1, BOW)] },
    ],
    keystone: [
      { name: 'Deadeye', icon: '👁️', mods: [pierce(3), slower(0.2, BOW)] },
      { name: 'Skirmisher', icon: '🐺', mods: [lighter(0.5, 'backstep'), dmg(-0.15, BOW)] },
    ],
  },
];
// Where two disciplines meet.
const BRIDGE = [
  { name: 'Martial Lore', mods: [dmg(0.03, WEAPONS)] },
  { name: 'Arcane Lore', mods: [spell(0.03)] },
];

// ---------- Building it ----------

const rnd = rng(11);
const slotsOf = (k) => 8 * Math.round((2 * Math.PI * RADII[k]) / 54 / 8);
const spineOf = (k, reg) => ((MIDS[reg] + 180) * slotsOf(k)) / 360;
const regionOf = (deg) => (deg > -90 && deg < 0 ? 0 : deg > 0 && deg < 90 ? 1 : deg > 90 && deg < 180 ? 2 : deg > -180 && deg < -90 ? 3 : -1);

const forced = new Map();
for (const [reg, k, off, id] of PLAN) {
  const n = slotsOf(k);
  forced.set(`${k}:${(spineOf(k, reg) + off + n) % n}`, id);
}

const nodes = [];
const at = new Map();
for (let k = 0; k < RADII.length; k++) {
  const n = slotsOf(k);
  for (let j = 0; j < n; j++) {
    const deg = -180 + (j * 360) / n;
    const region = regionOf(deg);
    const key = `${k}:${j}`;
    const spine = region >= 0 && j === spineOf(k, region);
    const keep = region < 0 ? BRIDGES.has(k) : spine || forced.has(key) || (k === 0 && Math.abs(j - spineOf(k, region)) <= 1) || rnd() < 0.6;
    if (!keep) continue;
    const node = { key, k, j, deg, region, spine, kind: 'small', adj: new Set(), skill: forced.get(key) || '' };
    if (node.skill) node.kind = 'skill';
    nodes.push(node);
    at.set(key, node);
  }
}

const edges = new Map();
const link = (a, b, arc = false) => {
  if (a === b) return;
  const key = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
  if (edges.has(key)) return;
  edges.set(key, { a, b, arc });
  a.adj.add(b);
  b.adj.add(a);
};
// Arcs along each orbit; only the bridge orbits cross from one discipline into the next.
for (let k = 0; k < RADII.length; k++) {
  const n = slotsOf(k);
  const ring = nodes.filter((x) => x.k === k).sort((p, q) => p.j - q.j);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const gap = (b.j - a.j + n) % n;
    if (gap === 0 || gap > 2) continue;
    if (a.region === b.region || a.region < 0 || b.region < 0) link(a, b, true);
  }
}
const angleGap = (a, b) => Math.abs(((a.deg - b.deg + 540) % 360) - 180);
const nearestOn = (node, k) => {
  let best = null;
  for (const x of nodes) if (x.k === k && (!best || angleGap(x, node) < angleGap(best, node))) best = x;
  return best;
};
for (const [child, parent] of Object.entries(PARENT)) link(nodes.find((x) => x.skill === child), nodes.find((x) => x.skill === parent));
// Spokes inward: always along the spine, sometimes elsewhere.
for (const node of nodes) {
  if (node.k === 0) continue;
  const inner = nearestOn(node, node.k - 1);
  const step = 360 / slotsOf(node.k - 1);
  if (node.spine && inner.spine) link(node, inner);
  else if (angleGap(node, inner) <= step * 1.1 && inner.region === node.region && rnd() < 0.38) link(node, inner);
}
// Every run of an orbit reaches the orbit inside it, and a long run gets a notable in its middle.
for (let k = 1; k < RADII.length; k++) {
  const seen = new Set();
  for (const start of nodes.filter((x) => x.k === k)) {
    if (seen.has(start)) continue;
    const run = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const x = stack.pop();
      run.push(x);
      for (const y of x.adj) if (y.k === k && !seen.has(y)) (seen.add(y), stack.push(y));
    }
    if (!run.some((x) => [...x.adj].some((y) => y.k === k - 1))) {
      let best = null;
      for (const x of run) {
        const inner = nearestOn(x, k - 1);
        if (!best || angleGap(x, inner) < best.d) best = { x, inner, d: angleGap(x, inner) };
      }
      link(best.x, best.inner);
    }
    if (k >= 2 && run.length >= 3) {
      const mid = run.sort((p, q) => p.j - q.j)[Math.floor(run.length / 2)];
      if (mid.kind === 'small' && mid.region >= 0) mid.kind = 'notable';
    }
  }
}
// Keystones at the rim of each discipline, and one more an orbit in.
for (let reg = 0; reg < 4; reg++) {
  const outer = at.get(`7:${spineOf(7, reg)}`);
  outer.kind = 'keystone';
  outer.keystone = 0;
  const k6 = nodes
    .filter((x) => x.k === 6 && x.region === reg && x.kind === 'small')
    .sort((p, q) => Math.abs(p.j - spineOf(6, reg) - 4) - Math.abs(q.j - spineOf(6, reg) - 4))[0];
  k6.kind = 'keystone';
  k6.keystone = 1;
}
// Nothing may be cut off: whatever the roots can't reach joins the nearest thing they can.
const reachable = () => {
  const seen = new Set(nodes.filter((x) => ROOTS.has(x.skill)));
  const queue = [...seen];
  while (queue.length) for (const y of queue.shift().adj) if (!seen.has(y)) (seen.add(y), queue.push(y));
  return seen;
};
for (let pass = 0; pass < 50; pass++) {
  const seen = reachable();
  const lost = nodes.find((x) => !seen.has(x));
  if (!lost) break;
  let best = null;
  for (const y of seen) {
    if (Math.abs(y.k - lost.k) > 1 || (y.region !== lost.region && lost.region >= 0 && y.region >= 0)) continue;
    const d = angleGap(y, lost) + Math.abs(y.k - lost.k) * 3;
    if (!best || d < best.d) best = { y, d };
  }
  if (!best) throw new Error(`can't connect ${lost.key}`);
  link(lost, best.y, best.y.k === lost.k);
}
if (reachable().size !== nodes.length) throw new Error('the tree is not connected');

// ---------- What each one is ----------

const skillById = new Map(SKILLS.map((s) => [s.id, s]));
const counts = { small: [0, 0, 0, 0], notable: [0, 0, 0, 0], bridge: 0 };
const ids = new Map();
for (const x of nodes) {
  if (x.kind === 'notable' && counts.notable[x.region] >= DISCIPLINES[x.region].notable.length) x.kind = 'small';
  if (x.kind === 'skill') {
    const s = skillById.get(x.skill);
    if (!s) throw new Error(`no skill "${x.skill}"`);
    x.out = { ...s };
  } else if (x.region < 0) {
    x.out = { id: '', kind: 'small', tree: -1, ...BRIDGE[counts.bridge++ % BRIDGE.length] };
  } else {
    const d = DISCIPLINES[x.region];
    const def = x.kind === 'keystone' ? d.keystone[x.keystone] : x.kind === 'notable' ? d.notable[counts.notable[x.region]++] : d.small[counts.small[x.region]++ % d.small.length];
    x.out = { id: '', kind: x.kind, tree: x.region, ...def };
  }
  // A node is named for its place: orbit and slot, which never change unless the tree is laid out again.
  if (!x.out.id) x.out.id = `${['sw', 'rs', 'py', 'ar'][x.region] ?? 'br'}-${x.k}-${x.j}`;
  ids.set(x, x.out.id);
}

// The skills first, in their old order, then everything else by orbit and angle.
const ordered = [
  ...SKILLS.map((s) => nodes.find((x) => x.skill === s.id)),
  ...nodes.filter((x) => x.kind !== 'skill').sort((p, q) => p.k - q.k || p.deg - q.deg),
];
const round = (v) => Math.round(v * 100) / 100;
const out = {
  comment:
    'The skill tree, laid out by tools/skilltree/gen.mjs (npm run skilltree) and editable by hand. The order of nodes is what a saved build means: append, never reorder. A node can be learned when it is a root or touches a node you have learned; links are the lines between them (arc: drawn along the orbit). o is the orbit (radii), a the angle in degrees clockwise from up. mods use the stats in tuning.json.',
  radii: RADII,
  nodes: ordered.map((x) => ({ ...x.out, ...(ROOTS.has(x.skill) ? { root: true } : {}), o: x.k, a: round(x.deg) })),
  links: [...edges.values()].map((e) => (e.arc ? [ids.get(e.a), ids.get(e.b), 1] : [ids.get(e.a), ids.get(e.b)])),
};
if (out.nodes.length > tuning.skills.maxNodes) throw new Error(`${out.nodes.length} nodes, over maxNodes ${tuning.skills.maxNodes}`);

// One node per line keeps the file readable and its diffs small.
const lines = [
  '{',
  `  "comment": ${JSON.stringify(out.comment)},`,
  `  "radii": ${JSON.stringify(out.radii)},`,
  '  "nodes": [',
  out.nodes.map((n) => `    ${JSON.stringify(n)}`).join(',\n'),
  '  ],',
  '  "links": [',
  out.links.map((l) => `    ${JSON.stringify(l)}`).join(',\n'),
  '  ]',
  '}',
  '',
];
fs.writeFileSync(OUT, lines.join('\n'));
const kinds = {};
for (const n of out.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
console.log(`${out.nodes.length} nodes (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ')}), ${out.links.length} links -> ${path.relative(ROOT, OUT)}`);
