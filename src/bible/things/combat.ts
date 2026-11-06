// Weapons, abilities, movement skills and every node of the skill tree.

import { ADJACENT, NODES, type SkillMod, type SkillNode, STATS, TREES } from '../../skills';
import { ABILITIES, type Ability, type AttackStep, type MovementSkill, MOVEMENT_SKILLS, type Weapon, WEAPONS } from '../../tuning';
import { change, count, frames, metres, num, pct, speed, times } from '../format';
import { described, join, kind, note, table } from '../kit';
import { type Html, link, md, phrase, plainNumber, raw } from '../md';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const grantedBy = (f: (n: SkillNode) => boolean): Html | null => {
  const n = NODES.find(f);
  return n ? link(`skills/${n.id}`, n.name) : null;
};

// ---------- weapons ----------

const stepRow = (s: AttackStep, i: number | string): Array<Html | string | number> => [
  typeof i === 'number' ? `Hit ${i + 1}` : i,
  frames(s.startup),
  frames(s.active),
  frames(s.recovery),
  num(s.damage),
  s.projectileSpeed ? phrase`${speed(s.projectileSpeed)}, ${metres(s.projectileRange ?? 0)}` : metres(s.reach),
  raw(`${s.arcDeg}°`),
  speed(s.lunge),
  speed(s.playerKnock),
  frames(s.cancelAfter),
];

export const weapons = kind<Weapon>({
  id: 'weapons',
  section: 'things',
  title: 'Weapons',
  noun: 'Weapon',
  icon: '⚔️',
  summary: 'The four weapons and their combos: every swing and shot with its timing, damage and reach.',
  sources: ['shared/tuning.json#weapons'],
  systems: ['combat', 'skills'],
  all: () => WEAPONS,
  key: (w) => w.name,
  name: (w) => w.title,
  iconOf: (w) => w.icon,
  line: (w) => `A ${w.tags.join(' ')} weapon with a combo of ${w.combo.length} ${w.combo.length === 1 ? 'hit' : 'hits'}.`,
  explain: (w) => note('weapons', w.name),
  facts: (w) => [
    ['Combo', count(w.combo.length, 'hit')],
    ['Damage', raw(w.combo.map((s) => num(s.damage).html).join(' · '))],
    ['Kind', w.tags.map(cap).join(', ')],
    ['Learned from', grantedBy((n) => n.grants?.weapon === WEAPONS.indexOf(w))],
  ],
  body: (w) =>
    join(
      md`## The Combo`,
      md`Each press of attack swings the next hit of the combo. A hit winds up, is live (it lands on anything in reach and in its arc), then recovers; after its *cancel* frames you can jump or slide out of the recovery. [[systems/combat]] has the rules.`,
      table(
        [
          'Hit',
          'Wind-Up',
          'Live',
          'Recovery',
          'Damage',
          w.combo.some((s) => s.projectileSpeed) ? 'Flies, Reaches' : 'Reach',
          'Arc',
          'Lunge',
          'Knock',
          'Cancel After',
        ],
        w.combo.map(stepRow),
        [4],
      ),
      w.variants?.length ? md`## Variants` : null,
      w.variants?.length
        ? table(
            ['Hit', 'Wind-Up', 'Live', 'Recovery', 'Damage', 'Reach', 'Arc', 'Lunge', 'Knock', 'Cancel After'],
            w.variants.map((v) => stepRow(v.step, `${cap(v.id)} (hit ${v.replace + 1})`)),
            [4],
          )
        : null,
      w.variants?.length
        ? md`A variant takes the place of one hit of the combo once you learn the skill that grants it: ${raw(
            w.variants.map((v) => grantedBy((n) => n.grants?.combo === v.id)?.html ?? v.id).join(', '),
          )}.`
        : null,
    ),
  columns: [
    ['Combo', (w) => count(w.combo.length, 'hit')],
    ['Damage', (w) => raw(w.combo.map((s) => num(s.damage).html).join(' · '))],
  ],
});

// ---------- abilities ----------

export const abilities = kind<Ability>({
  id: 'abilities',
  section: 'things',
  title: 'Abilities',
  noun: 'Ability',
  icon: '✨',
  summary: 'Spells on the hotbar: how long they take to cast, what they cost and what they do.',
  sources: ['shared/tuning.json#abilities'],
  systems: ['combat', 'skills'],
  all: () => ABILITIES,
  key: (a) => a.id,
  name: (a) => a.name,
  iconOf: (a) => a.icon,
  line: (a) => a.desc,
  explain: (a) => described(a.desc),
  facts: (a) => [
    ['Aimed', a.target === 'ground' ? 'At a spot on the ground' : 'On yourself'],
    ['Cast', frames(a.castFrames)],
    ['Cooldown', frames(a.cooldownFrames)],
    ['MP', a.mpCost ?? 0],
    ['Range', a.range ? metres(a.range) : null],
    ['Furthest', a.maxRange ? metres(a.maxRange) : null],
    ['Learned from', grantedBy((n) => n.grants?.ability === ABILITIES.indexOf(a))],
  ],
  body: (a) =>
    join(
      md`## What It Does`,
      table(
        ['Effect', 'Radius', 'Heals', 'Damage', 'Knock', 'Lands After'],
        a.effects.map((e) => [
          e.kind === 'healArea' ? 'Heals everyone near' : e.kind === 'delayedArea' ? 'Strikes an area after a delay' : e.kind,
          metres(e.radius),
          e.amount ?? '',
          e.damage ?? '',
          e.knock ? speed(e.knock) : '',
          e.delayFrames ? frames(e.delayFrames) : '',
        ]),
        [1, 2, 3, 4, 5],
      ),
      md`Its cast is paid in MP when it goes off; a cast you cancel or that is interrupted costs nothing. Skills in the tree can change its numbers: [[systems/skills]].`,
    ),
  columns: [
    ['Cast', (a) => frames(a.castFrames)],
    ['Cooldown', (a) => frames(a.cooldownFrames)],
    ['MP', (a) => a.mpCost ?? 0],
  ],
});

// ---------- movement skills ----------

const DIRECTION: Record<string, string> = { input: 'The way you push the stick', facing: 'The way you face', backward: 'Straight back' };

export const movement = kind<MovementSkill>({
  id: 'movement',
  section: 'things',
  title: 'Movement Skills',
  noun: 'Movement Skill',
  icon: '🤸',
  summary: 'Dodges, the block and the slide: their timing, cost and the frames that can’t be hit.',
  sources: ['shared/tuning.json#movementSkills', 'shared/tuning.json#movementSlots'],
  systems: ['combat', 'moving'],
  all: () => MOVEMENT_SKILLS,
  key: (m) => m.id,
  name: (m) => m.name,
  iconOf: (m) => m.icon,
  line: (m) => m.desc,
  explain: (m) => described(m.desc),
  facts: (m) => {
    const a = m.action;
    return [
      ['Everyone has it', m.builtin ? 'Yes' : null],
      ['Learned from', m.builtin ? null : grantedBy((n) => n.grants?.movement === MOVEMENT_SKILLS.indexOf(m))],
      ['Stamina', m.staminaCost ?? null],
      ['Cooldown', m.cooldownFrames ? frames(m.cooldownFrames) : null],
      ['Goes', DIRECTION[a.direction] ?? a.direction],
      ['Speed', a.endSpeed !== undefined ? phrase`${speed(a.speed)} easing to ${speed(a.endSpeed)}` : a.speed ? speed(a.speed) : null],
      ['Steer', a.steer ? raw(`${Math.round((a.steer * 180) / Math.PI)}°/s`) : null],
      ['Held', a.hold ? 'As long as you hold it' : null],
      ['Damage taken', a.damageTaken !== undefined ? times(a.damageTaken) : null],
      ['Jumping out keeps', a.jumpCarry ? change(a.jumpCarry - 1) : null],
    ];
  },
  body: (m) => {
    const a = m.action;
    return join(
      md`## Its Timeline`,
      table(
        ['Start-Up', 'Active', 'Recovery', 'Can’t Be Hit'],
        [
          [
            frames(a.startup),
            frames(a.active),
            frames(a.recovery),
            a.invulnFrom !== undefined && a.invulnTo !== undefined ? phrase`frames ${a.invulnFrom} to ${a.invulnTo}` : 'No',
          ],
        ],
      ),
      md`[[systems/combat]] says how movement skills fit with attacks, and [[systems/skills]] how the tree and levels change their cost and cooldown.`,
    );
  },
  columns: [
    ['Stamina', (m) => m.staminaCost ?? ''],
    ['Cooldown', (m) => (m.cooldownFrames ? frames(m.cooldownFrames) : '')],
  ],
});

// ---------- the skill tree ----------

const statDesc = (id: string): string => STATS.find((s) => s.id === id)?.desc ?? id;

const scopeOf = (m: SkillMod): string => {
  const parts: string[] = [];
  if (m.weapon !== undefined) parts.push(`with the ${WEAPONS[m.weapon]?.title.toLowerCase() ?? `weapon ${m.weapon}`}`);
  if (m.skill)
    parts.push(
      `for ${ABILITIES.find((a) => a.id === m.skill)?.name ?? MOVEMENT_SKILLS.find((x) => x.id === m.skill)?.name ?? NODES.find((n) => n.id === m.skill)?.name ?? m.skill}`,
    );
  if (m.tags?.length) parts.push(`for skills that are ${m.tags.join(' and ')}`);
  return parts.join(', ');
};

/** A modifier in words: what it changes, by how much, and when. */
export function modText(m: SkillMod): Html {
  const by =
    m.op === 'flat'
      ? raw(`<span class="v">${m.value > 0 ? '+' : '−'}${plainNumber(Math.abs(m.value))}</span>`)
      : m.op === 'inc'
        ? phrase`${change(m.value)} increased`
        : phrase`${pct(Math.abs(m.value))} ${m.value >= 0 ? 'more' : 'less'}`;
  const scope = scopeOf(m);
  return phrase`${statDesc(m.stat)}: ${by}${scope ? `, ${scope}` : ''}`;
}

const grantText = (n: SkillNode): Html | null => {
  const g = n.grants;
  if (!g) return null;
  if (g.weapon !== undefined) return phrase`Lets you wield ${link(`weapons/${WEAPONS[g.weapon]?.name}`)}.`;
  if (g.ability !== undefined) return phrase`Teaches ${link(`abilities/${ABILITIES[g.ability]?.id}`)}.`;
  if (g.movement !== undefined) return phrase`Teaches ${link(`movement/${MOVEMENT_SKILLS[g.movement]?.id}`)}.`;
  if (g.combo) {
    const w = WEAPONS.find((x) => x.variants?.some((v) => v.id === g.combo));
    return phrase`Changes ${w ? link(`weapons/${w.name}`) : 'a weapon'}'s combo: ${g.combo}.`;
  }
  return null;
};

const KIND_NAME: Record<string, string> = { skill: 'Skill', small: 'Passive', notable: 'Notable Passive', keystone: 'Keystone' };
const treeName = (n: SkillNode): string => TREES[n.tree]?.name ?? 'Between the Trees';

export const skills = kind<SkillNode>({
  id: 'skills',
  section: 'things',
  title: 'The Skill Tree',
  noun: 'Skill',
  icon: '🌳',
  summary: 'Every node of the skill tree: the skills, the passives, the notables and the keystones, and what each changes.',
  sources: ['shared/skilltree.json#nodes', 'shared/skilltree.json#links', 'shared/skilltree.json#radii'],
  systems: ['skills'],
  all: () => NODES,
  key: (n) => n.id,
  name: (n) => n.name,
  iconOf: (n) => n.icon,
  group: treeName,
  line: (n) => n.desc ?? `${KIND_NAME[n.kind]} of ${treeName(n)}.`,
  explain: (n) => {
    if (n.desc) return described(n.desc);
    const lines = [grantText(n), ...(n.mods ?? []).map(modText)].filter((x): x is Html => !!x);
    return lines.length ? raw(`<ul>${lines.map((l) => `<li>${l.html}</li>`).join('')}</ul>`) : null;
  },
  facts: (n) => [
    ['Tree', treeName(n)],
    ['Kind', KIND_NAME[n.kind] ?? n.kind],
    ['Ring', n.o + 1],
    ['Learn first', n.root ? 'Nothing: a root of the tree' : null],
    ['Grants', grantText(n)],
  ],
  body: (n) => {
    const i = NODES.indexOf(n);
    const near = (ADJACENT[i] ?? []).map((j) => NODES[j]).filter(Boolean);
    return join(
      n.desc && n.mods?.length ? md`## Exactly` : null,
      n.desc && n.mods?.length ? raw(`<ul>${n.mods.map((m) => `<li>${modText(m).html}</li>`).join('')}</ul>`) : null,
      near.length ? md`## Next To It` : null,
      near.length ? md`You can learn it once you have learned a skill next to it${n.root ? phrase`, or with nothing learned, as it is a root` : ''}:` : null,
      near.length
        ? raw(`<ul>${near.map((x) => `<li>${link(`skills/${x.id}`, x.name).html} <small>(${treeName(x)}, ${KIND_NAME[x.kind]})</small></li>`).join('')}</ul>`)
        : null,
    );
  },
  columns: [
    ['Kind', (n) => KIND_NAME[n.kind] ?? n.kind],
    ['Does', (n) => n.desc ?? raw((n.mods ?? []).map((m) => modText(m).html).join('; '))],
  ],
});
