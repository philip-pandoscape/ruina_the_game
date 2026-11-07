// Skills, Builds and the Skill Tree: written from its rules (`rules` below); every number from the content and the rules.

import { QUESTS } from '../../content/quests';
import {
  applyChannel,
  applyFrames,
  BOOK,
  hasSkill,
  LEVEL_MODS,
  LEVEL_XP,
  MAX_LEVEL,
  NODES,
  ORBITS,
  type SkillMod,
  type SkillNode,
  START_POINTS,
  STATS,
  TREES,
} from '../../content/skills';
import { ABILITIES, DEFAULT_BUILD, HOTBAR_SLOTS, MOVEMENT_SKILLS, MOVEMENT_SLOTS, WEAPONS, weaponIndex } from '../../content/tuning';
import { change, count, num, pct } from '../format';
import { system, table } from '../kit';
import { type Html, link, md, phrase, raw } from '../md';
import { modText } from '../things/combat';

/** A node by its id; a page that names one the tree no longer has fails the completeness test. */
function node(id: string): SkillNode {
  const n = NODES.find((x) => x.id === id);
  if (!n) throw new Error(`the skills page names a node the tree doesn't have: ${id}`);
  return n;
}

const nodeLink = (n: SkillNode): Html => link(`skills/${n.id}`, n.name);
/** The weapon whose combo a variant belongs to. */
const comboOwner = (variant: string | undefined) => WEAPONS.find((w) => w.variants?.some((v) => v.id === variant));
const treeName = (i: number): string => TREES[i]?.name ?? 'Between the Trees';

/** A node's modifier on a stat (the first one), for the worked examples. */
function modOf(id: string, stat: string): SkillMod {
  const m = node(id).mods?.find((x) => x.stat === stat);
  if (!m) throw new Error(`the skills page expects ${id} to change ${stat}`);
  return m;
}

/** How each stat is applied by the rules (src/content/tuning.ts): rounded to whole frames, kept at one or more, never below nothing. */
const APPLIED: Record<string, string> = {
  'attack.startup': 'Rounded to whole frames',
  'cast.frames': 'Rounded to whole frames, at least one',
  'ability.cooldown': 'Rounded to whole frames',
  'movement.cooldown': 'Rounded to whole frames',
  'melee.maxTargets': 'Rounded, at least one',
  'projectile.pierce': 'Rounded, at least one',
  'movement.stamina': 'Never below nothing',
  'ability.mp': 'Never below nothing',
};

/** What each weapon, ability and movement skill carries, for which modifiers reach it. */
const TAGGED: Array<[Html, string]> = [
  ...WEAPONS.map((w): [Html, string] => [link(`weapons/${w.name}`, w.title), w.tags.join(', ')]),
  ...ABILITIES.map((a): [Html, string] => [link(`abilities/${a.id}`, a.name), a.tags.join(', ')]),
  ...MOVEMENT_SKILLS.map((m): [Html, string] => [link(`movement/${m.id}`, m.name), m.tags.join(', ')]),
];

const bookName = (id: string, kind: string, index: number): Html =>
  kind === 'weapon'
    ? link(`weapons/${WEAPONS[index]?.name}`, WEAPONS[index]?.title ?? id)
    : kind === 'ability'
      ? link(`abilities/${id}`, ABILITIES[index]?.name ?? id)
      : link(`movement/${id}`, MOVEMENT_SKILLS[index]?.name ?? id);

export const skills = system({
  id: 'skills',
  title: 'Skills, Builds and the Skill Tree',
  summary: 'The classless skill tree: points, learning and unlearning, modifiers and how they add up, and skills that level up as you use them.',
  icon: '🌳',
  keywords: [
    'build',
    'skill tree',
    'tree',
    'passive',
    'notable',
    'keystone',
    'points',
    'respec',
    'unlearn',
    'level',
    'experience',
    'xp',
    'hotbar',
    'loadout',
    'modifier',
  ],
  rules: ['src/content/skills.ts', 'src/content/build.ts', 'crates/engine/src/skills.rs', 'crates/engine/src/tuning.rs', 'crates/engine/src/life/progress.rs'],
  content: ['shared/tuning.json#skills', 'shared/tuning.json#stats'],
  body: () => {
    const earned = QUESTS.filter((q) => q.rewards.skillPoints);
    const fromQuests = earned.reduce((t, q) => t + (q.rewards.skillPoints ?? 0), 0);
    const roots = NODES.filter((n) => n.root);
    const kinds = (tree: number, k: string) => NODES.filter((n) => n.tree === tree && n.kind === k).length;
    const between = NODES.filter((n) => !TREES[n.tree]);
    const grants = NODES.filter((n) => n.grants);
    const levelUps = QUESTS.find((q) => q.steps.some((s) => s.objectives.some((o) => o.type === 'skillLevel')));
    const known = NODES.filter((_, i) => hasSkill(DEFAULT_BUILD.skills, i));

    // The worked examples: real nodes, real numbers.
    const sword = WEAPONS[weaponIndex('sword')];
    const keen = modOf('sw-3-17', 'attack.damage');
    const storm = modOf('sw-7-27', 'attack.damage');
    const hit = sword.combo[0];
    const damaged = applyChannel({ flat: 0, inc: keen.value + storm.value, more: 1 }, hit.damage);
    const bow = WEAPONS.find((w) => w.combo.some((s) => s.projectileSpeed)) ?? WEAPONS[0];
    const draw = bow.combo[0].startup;
    const rapid = modOf('rapidFire', 'attack.startup');
    const quick = modOf('ar-5-7', 'attack.startup');
    const deadeye = modOf('ar-7-9', 'attack.startup');
    const more = (1 + rapid.value) * (1 + quick.value) * (1 + deadeye.value);
    const drawn = applyFrames({ flat: 0, inc: 0, more }, draw);
    const cleave = modOf('cleave', 'melee.maxTargets');
    const targets = STATS.find((s) => s.id === 'melee.maxTargets')?.base ?? 1;

    return md`
Ruina has no classes. Everything you can do in a fight (each weapon, each spell, each dodge) and everything that makes it better is a node of one skill tree of ${count(NODES.length, 'node')}, in ${count(TREES.length, 'discipline')}. You spend points to learn nodes outward from where the tree starts, and what you learn is your *build*: your weapons, your hotbar and the modifiers that change them. The skills you use also level up on their own.

## Skill Points

Every node you learn takes one point, and you can never have more learned than your points allow.

- **In the world** you start with ${count(START_POINTS, 'point')}, and each quest and milestone that rewards points adds them when you finish it: ${count(fromQuests, 'point')} in all from the ${count(earned.length, 'quest')} that do, so ${count(START_POINTS + fromQuests, 'point')} once every one is done. Your points are counted from the quests you have finished, never stored, so they can't drift from them.
- **A new character** already knows ${raw(known.map((n) => nodeLink(n).html).join(', '))}, which takes ${count(known.length, 'point')} of them.

${table(
  ['Quest', 'Points'],
  earned.map((q) => [link(`quests/${q.id}`, q.name), q.rewards.skillPoints ?? 0]),
  [1],
)}

## Learning and Unlearning

- **Where you can learn.** A node is open when it is a root of the tree (${raw(roots.map((r) => nodeLink(r).html).join(', '))}) or touches a node you have learned. Pick one further away and the whole shortest path to it is learned, nearest first, if you have the points for every step; where two paths are as short, the one through the earlier nodes in the tree's list is taken.
- **Unlearning is free** and gives the point back. Anything you learned through that node, which would no longer connect back to a root, is unlearned with it. You can't unlearn the last of your weapon skills.
- **Your slots follow.** A spell or a movement skill you learn goes into the first free hotbar or movement slot; one you unlearn leaves its slot; and if you unlearn the weapon in your hands you take up the first weapon you still know.
- **Each spell in one slot.** Your hotbar has ${count(HOTBAR_SLOTS, 'slot')} and you have ${count(MOVEMENT_SLOTS, 'movement slot')}; putting a skill in a new slot moves it there rather than copying it.
- **Changing your build mid-fight** drops whatever swing or cast you were in the middle of.

## The Tree

The tree is laid out in rings round its middle (${count(ORBITS.length, 'ring')}), each discipline in its own part, with its weapon skill at the root. There are four kinds of node:

- **Skills** grant something: a weapon, a spell, a movement skill or a new move in a weapon's combo, or a strong change to one.
- **Passives** are small steps along the way: a few percent more damage, a little faster.
- **Notables** are bigger passives, with names of their own.
- **Keystones** sit at the edge and change how you play, at a price: each gives a lot and takes something back.

${table(
  ['Discipline', 'Skills', 'Passives', 'Notables', 'Keystones'],
  TREES.map((t, i) => [t.name, kinds(i, 'skill'), kinds(i, 'small'), kinds(i, 'notable'), kinds(i, 'keystone')]),
  [1, 2, 3, 4],
)}

${between.length ? md`Between the disciplines lie ${count(between.length, 'passive')} that join one to the next, so a build can cross over.` : ''}

What every node grants:

${table(
  ['Skill', 'Discipline', 'Grants'],
  grants.map((n) => {
    const g = n.grants!;
    const what =
      g.weapon !== undefined
        ? phrase`the ${link(`weapons/${WEAPONS[g.weapon]?.name}`, WEAPONS[g.weapon]?.title ?? 'weapon')}`
        : g.ability !== undefined
          ? phrase`the spell ${link(`abilities/${ABILITIES[g.ability]?.id}`, ABILITIES[g.ability]?.name ?? 'spell')}`
          : g.movement !== undefined
            ? phrase`the movement skill ${link(`movement/${MOVEMENT_SKILLS[g.movement]?.id}`, MOVEMENT_SKILLS[g.movement]?.name ?? 'skill')}`
            : comboOwner(g.combo)
              ? phrase`a new move in the ${link(`weapons/${comboOwner(g.combo)!.name}`, comboOwner(g.combo)!.title)}'s combo`
              : phrase`a new move in a combo`;
    return [nodeLink(n), treeName(n.tree), what];
  }),
)}

## How Modifiers Add Up

A modifier changes one *stat* of what you do: the damage of a weapon's swings, the cast time of a spell, the stamina a dodge costs. It comes in one of three kinds, and every modifier from everything you have learned is gathered first, then applied in three stages, always in this order:

$$
value = (base + Σ flat) × (1 + Σ increased) × Π (1 + more)
$$

- **Flat** adds to the base: ${nodeLink(node('cleave'))} adds ${num(cleave.value)} to the targets a sword swing reaches, so it reaches ${num(targets + cleave.value)} instead of ${num(targets)}.
- **Increased** modifiers are added together before they multiply, so two of them are worth less than they look. A sword's first hit deals ${hit.damage}; with ${nodeLink(node('sw-3-17'))} (${change(keen.value)}) and ${nodeLink(node('sw-7-27'))} (${change(storm.value)}) it deals:

$$
${hit.damage} × (1 + ${num(keen.value)} + ${num(storm.value)}) = ${num(damaged)}
$$

- **More** and **less** modifiers each multiply on their own, one after another. The bow draws for ${count(draw, 'frame')}; with ${nodeLink(node('rapidFire'))} (${pct(Math.abs(rapid.value))} less), ${nodeLink(node('ar-5-7'))} (${pct(Math.abs(quick.value))} less) and ${nodeLink(node('ar-7-9'))} (${pct(deadeye.value)} more) it draws for:

$$
${draw} × (1 − ${num(Math.abs(rapid.value), 3)}) × (1 − ${num(Math.abs(quick.value))}) × (1 + ${num(deadeye.value)}) = ${num(draw * more)}, rounded to ${drawn}
$$

A modifier reaches only what it names. One can name a weapon, a spell or a movement skill; one that names *tags* reaches only what carries every one of them. Which modifiers a stat collects is worked out when your build or a level changes, never in the middle of a swing.

${table(
  ['Stat', 'What It Changes', 'Base', 'Applied'],
  STATS.map((s) => [raw(`<code>${s.id}</code>`), s.desc ?? '', s.base ?? 'The move’s own', APPLIED[s.id] ?? 'As the formula gives it']),
)}

${table(
  ['Skill', 'Carries the Tags'],
  TAGGED.map(([l, tags]) => [l, tags]),
)}

## Skills Level Up as You Use Them

Each weapon, spell and movement skill has a level in your skill book. It gains a point of experience for each hit it lands (a weapon), each cast that goes off (a spell) and each time you use it (a movement skill); a blast from a spell trains nothing more, as its cast already did. A level comes at each step of the curve, up to level ${MAX_LEVEL}, and each level past the first adds that skill's own modifiers once more. Levels only add flat or increased modifiers, never more, so the order they come in can't matter.

${table(
  ['Level', 'Experience'],
  LEVEL_XP.map((xp, i) => [i + 1, xp]),
  [0, 1],
)}

${table(
  ['Skill', 'Each Level Past the First', 'At the Top Level'],
  BOOK.map((b) => {
    const mods = LEVEL_MODS[b.id] ?? [];
    return [
      bookName(b.id, b.kind, b.index),
      mods.length ? raw(mods.map((m) => modText(m).html).join('<br>')) : 'Nothing yet',
      mods.length ? raw(mods.map((m) => modText({ ...m, value: m.value * (MAX_LEVEL - 1) }).html).join('<br>')) : '',
    ];
  }),
)}

Your experience is kept with your life. Every level-up also counts for quests that ask for them${levelUps ? phrase`, such as ${link(`quests/${levelUps.id}`, levelUps.name)}` : ''}.

## Your Build Online

Your build is kept on the game server with your character. Each time you change it, the server checks it before taking it: every learned node must connect back to a root, the count must be within your points, the weapon in your hands one you know, and every slot hold a skill you have learned, each in one slot only. A build that fails is refused, and you keep the one you had. Starting your life over takes its quests with it: your build stays only if the points a fresh life starts with still cover it, and otherwise you are back to the first build.
`;
  },
});
