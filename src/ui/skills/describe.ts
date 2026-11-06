import {
  ABILITIES,
  abilityCooldown,
  abilityMpFor,
  castFramesFor,
  comboFor,
  effectAmount,
  effectDamage,
  effectRadius,
  meleeTargets,
  movementCooldownFor,
  movementStaminaFor,
  MOVEMENT_SKILLS,
  pierceTargets,
  WEAPONS,
} from '../../content/tuning';
import { BOOK, LEVEL_XP, MAX_LEVEL, NODES, TREES, type BookSkill, type Levels, type ResolvedSkills, type SkillMod, type SkillNode } from '../../content/skills';

// Words for what skills and the tree do, drawn from the same numbers the rules use, so the text can
// never promise something the game doesn't do.

const pct = (v: number) => `${Math.round(Math.abs(v) * 100)}%`;
const signed = (v: number) => `${v < 0 ? '−' : '+'}${pct(v)}`;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const weaponWord = (w: number) => WEAPONS[w]?.name ?? 'weapon';
const moveName = (id: string) => MOVEMENT_SKILLS.find((m) => m.id === id)?.name ?? id;
const abilityName = (id: string) => ABILITIES.find((a) => a.id === id)?.name ?? id;

/** One modifier as a line of text: "+4% sword damage", "Bow draws 10% faster". */
export function describeMod(m: SkillMod): string {
  const t = m.tags ?? [];
  const w = m.weapon;
  switch (m.stat) {
    case 'attack.damage': {
      const what = w === 3 ? 'arrow' : w !== undefined ? weaponWord(w) : t.includes('melee') ? 'melee' : t.includes('ranged') ? 'ranged' : 'weapon';
      return `${signed(m.value)} ${what} damage`;
    }
    case 'attack.startup': {
      const who = w === 3 ? 'Bow draws' : w !== undefined ? `${cap(weaponWord(w))} attacks` : t.includes('melee') ? 'Melee attacks' : 'Attacks';
      return `${who} ${pct(m.value)} ${m.value < 0 ? 'faster' : 'slower'}`;
    }
    case 'melee.maxTargets':
      return `${cap(w !== undefined ? weaponWord(w) : 'melee')} swings hit ${m.value} more ${m.value === 1 ? 'enemy' : 'enemies'}`;
    case 'projectile.pierce':
      return `Arrows pierce ${m.value} more ${m.value === 1 ? 'enemy' : 'enemies'}`;
    case 'ability.amount':
      return `${signed(m.value)} healing`;
    case 'ability.radius':
      return `${signed(m.value)} ${m.skill === 'heal' || t.includes('heal') ? 'healing' : t.includes('fire') ? 'fire' : 'ability'} area`;
    case 'ability.damage':
      return `${signed(m.value)} ${m.skill ? abilityName(m.skill) : t.includes('fire') ? 'fire' : t.includes('spell') ? 'spell' : 'ability'} damage`;
    case 'cast.frames': {
      const who = m.skill ? abilityName(m.skill) : t.includes('heal') ? 'Healing spells' : t.includes('fire') ? 'Fire spells' : 'Spells';
      return `${who} ${m.skill ? 'casts' : 'cast'} ${pct(m.value)} ${m.value < 0 ? 'faster' : 'slower'}`;
    }
    case 'ability.cooldown':
      return `${m.skill ? abilityName(m.skill) : 'Ability'} cooldown ${pct(m.value)} ${m.value < 0 ? 'shorter' : 'longer'}`;
    case 'movement.cooldown':
      return `${m.skill ? moveName(m.skill) : 'Movement skills'} ${m.value < 0 ? 'recovers' : 'recover'} ${pct(m.value)} ${m.value < 0 ? 'faster' : 'slower'}`;
    case 'movement.stamina':
      return `${m.skill ? moveName(m.skill) : 'Movement skills'} ${m.skill ? 'costs' : 'cost'} ${pct(m.value)} ${m.value < 0 ? 'less' : 'more'} stamina`;
    case 'ability.mp':
      return `${m.skill ? abilityName(m.skill) : 'Abilities'} ${m.skill ? 'costs' : 'cost'} ${pct(m.value)} ${m.value < 0 ? 'less' : 'more'} MP`;
    default:
      return `${m.stat} ${m.op} ${m.value}`;
  }
}

/** What a tree node does, as lines. Skills say so in their own words; the rest list their effects. */
export function nodeLines(n: SkillNode): string[] {
  if (n.kind === 'skill') return [n.desc ?? ''];
  return (n.mods ?? []).map(describeMod);
}

export const KIND_NAMES: Record<SkillNode['kind'], string> = { skill: 'Skill', small: 'Passive', notable: 'Notable', keystone: 'Keystone' };
export const treeName = (tree: number) => TREES[tree]?.name ?? 'Crossroads';
export const treeColor = (tree: number) => TREES[tree]?.color ?? '#9a7a52';

// ---------- The skill book ----------

/** The tree node behind a book entry: the one that grants it, if any (slide is everyone's). */
export function grantingNode(b: BookSkill): number {
  return NODES.findIndex((n) =>
    b.kind === 'weapon' ? n.grants?.weapon === b.index : b.kind === 'ability' ? n.grants?.ability === b.index : n.grants?.movement === b.index,
  );
}

export function bookName(b: BookSkill): string {
  if (b.kind === 'weapon') return cap(weaponWord(b.index));
  if (b.kind === 'ability') return ABILITIES[b.index]?.name ?? b.id;
  return MOVEMENT_SKILLS[b.index]?.name ?? b.id;
}

export function bookIcon(b: BookSkill): string {
  if (b.kind === 'weapon') return NODES[grantingNode(b)]?.icon ?? '⚔️';
  if (b.kind === 'ability') return ABILITIES[b.index]?.icon ?? '✨';
  return MOVEMENT_SKILLS[b.index]?.icon ?? '💨';
}

export function bookTree(b: BookSkill): number {
  const i = grantingNode(b);
  return i >= 0 ? NODES[i].tree : -1;
}

export function bookDesc(b: BookSkill): string {
  if (b.kind === 'weapon') return NODES[grantingNode(b)]?.desc ?? '';
  if (b.kind === 'ability') return ABILITIES[b.index]?.desc ?? '';
  return MOVEMENT_SKILLS[b.index]?.desc ?? '';
}

export function bookType(b: BookSkill): string {
  const where = treeName(bookTree(b));
  if (b.kind === 'weapon') return `Weapon · ${where}`;
  if (b.kind === 'ability') return `Ability · ${where}${ABILITIES[b.index]?.tags.includes('spell') ? ' · Spell' : ''}`;
  return bookTree(b) >= 0 ? `Movement · ${where}` : 'Movement · Everyone Knows It';
}

/** What a skill gains experience from, for "128 / 200 hits". */
export const xpUnit = (b: BookSkill) => (b.kind === 'weapon' ? 'hits' : b.kind === 'ability' ? 'casts' : 'uses');

const secs = (frames: number) => `${(frames / 60).toFixed(frames % 60 === 0 ? 0 : frames < 60 ? 2 : 1)} s`;
const num = (v: number) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

/** A weapon's damage hit by hit through its combo, "12.4 · 14.4 · 26.8". */
export const comboDamage = (weapon: number, r: ResolvedSkills): string =>
  comboFor(weapon, r)
    .map((s) => num(s.damage))
    .join(' · ');

/** A skill's numbers as it stands: [label, value] pairs. */
export function bookStats(b: BookSkill, r: ResolvedSkills): Array<[string, string]> {
  if (b.kind === 'weapon') {
    const steps = comboFor(b.index, r);
    const w = WEAPONS[b.index];
    const out: Array<[string, string]> = [
      ['Damage', comboDamage(b.index, r)],
      ['Combo', `${steps.length} ${steps.length === 1 ? 'Hit' : 'Hits'}`],
      [w.tags.includes('ranged') ? 'Draw' : 'Wind-up', secs(steps[0]?.startup ?? 0)],
    ];
    if (w.tags.includes('ranged')) out.push(['Pierces', `${pierceTargets(b.index, r)} ${pierceTargets(b.index, r) === 1 ? 'Enemy' : 'Enemies'}`]);
    else out.push(['Hits per Swing', `Up to ${meleeTargets(b.index, r)}`]);
    return out;
  }
  if (b.kind === 'ability') {
    const a = ABILITIES[b.index];
    const out: Array<[string, string]> = [];
    for (const e of a.effects) {
      if (e.amount) out.push(['Heals', num(effectAmount(b.index, e, r))]);
      if (e.damage) out.push(['Damage', num(effectDamage(b.index, e, r))]);
      out.push(['Radius', `${num(effectRadius(b.index, e, r))} m`]);
    }
    out.push(['Cast Time', secs(castFramesFor(b.index, r))]);
    out.push(['Cooldown', secs(abilityCooldown(b.index, r))]);
    const mp = abilityMpFor(b.index, r);
    if (mp > 0) out.push(['MP Cost', num(mp)]);
    return out;
  }
  // A dodge costs stamina and has no cooldown; a guard and the slide the other way round.
  const out: Array<[string, string]> = [];
  const stamina = movementStaminaFor(b.index, r);
  if (stamina > 0) out.push(['Stamina Cost', num(stamina)]);
  const cooldown = movementCooldownFor(b.index, r);
  if (cooldown > 0 || stamina <= 0) out.push(['Recovers In', secs(cooldown)]);
  return out;
}

/** The levels with this one skill a level higher, for "Level 4: Heals 30". */
export function levelsWithNext(levels: Levels, b: number): Levels {
  return levels.map((l, i) => (i === b ? Math.min(MAX_LEVEL, l + 1) : l));
}

/** Experience into the current level, and how much that level takes. */
export function levelProgress(xp: number, level: number): { have: number; need: number; max: boolean } {
  if (level >= MAX_LEVEL) return { have: 1, need: 1, max: true };
  const from = LEVEL_XP[level - 1] ?? 0;
  return { have: xp - from, need: (LEVEL_XP[level] ?? from + 1) - from, max: false };
}

export const BOOK_GROUPS: Array<{ title: string; kind: BookSkill['kind'] }> = [
  { title: 'Weapons', kind: 'weapon' },
  { title: 'Abilities', kind: 'ability' },
  { title: 'Movement', kind: 'movement' },
];

export const bookEntries = (kind: BookSkill['kind']) => BOOK.map((b, i) => ({ b, i })).filter((x) => x.b.kind === kind);
