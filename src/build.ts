import { ABILITIES, DEFAULT_BUILD, NO_ABILITY, SKILLS, type Build, type SkillNode } from './tuning';

// Skill trees: learning and unlearning skills, and picking a loadout from what you've learned.
// server/src/tuning.rs (valid_build) checks the same rules, so a build that passes here is accepted.

export interface NodeInfo {
  tree: number;
  index: number; // position in its tree, top to bottom
  bit: number;
  node: SkillNode;
}

export const NODES: NodeInfo[] = SKILLS.trees.flatMap((tree, t) =>
  tree.nodes.map((node, index) => ({ tree: t, index, bit: SKILLS.trees.slice(0, t).reduce((n, tr) => n + tr.nodes.length, 0) + index, node })),
);

export const has = (perks: number, bit: number) => (perks & (1 << bit)) !== 0;

export function pointsUsed(perks: number): number {
  let n = 0;
  for (let p = perks; p; p &= p - 1) n++;
  return n;
}

export const pointsLeft = (perks: number) => SKILLS.points - pointsUsed(perks);

export const weaponsOf = (perks: number) => NODES.filter((n) => n.node.weapon !== undefined && has(perks, n.bit)).map((n) => n.node.weapon!);
export const abilitiesOf = (perks: number) => NODES.filter((n) => n.node.ability !== undefined && has(perks, n.bit)).map((n) => n.node.ability!);

// Why a skill can't be learned right now, or null if it can.
export function learnBlock(perks: number, info: NodeInfo): string | null {
  if (has(perks, info.bit)) return 'Already learned';
  if (info.index > 0 && !has(perks, info.bit - 1)) return `Learn ${SKILLS.trees[info.tree].nodes[info.index - 1].name} first`;
  if (pointsLeft(perks) <= 0) return 'No skill points left';
  return null;
}

// Why a skill can't be unlearned, or null if it can. Unlearning also drops the skills below it.
export function unlearnBlock(perks: number, info: NodeInfo): string | null {
  if (!has(perks, info.bit)) return 'Not learned';
  if (weaponsOf(dropFrom(perks, info)).length === 0) return 'Keep at least one weapon skill';
  return null;
}

function dropFrom(perks: number, info: NodeInfo): number {
  let p = perks;
  for (const n of NODES) if (n.tree === info.tree && n.index >= info.index) p &= ~(1 << n.bit);
  return p;
}

export function learn(b: Build, info: NodeInfo): Build {
  const perks = b.perks | (1 << info.bit);
  const next = fixLoadout({ ...b, perks });
  // A newly learned ability goes straight into a free slot.
  const a = info.node.ability;
  if (a !== undefined && next.ability1 !== a && next.ability2 !== a) {
    if (next.ability1 === NO_ABILITY) next.ability1 = a;
    else if (next.ability2 === NO_ABILITY) next.ability2 = a;
  }
  return next;
}

export function unlearn(b: Build, info: NodeInfo): Build {
  return fixLoadout({ ...b, perks: dropFrom(b.perks, info) });
}

// Keeps the loadout to things you've actually learned.
export function fixLoadout(b: Build): Build {
  const weapons = weaponsOf(b.perks);
  const abilities = abilitiesOf(b.perks);
  const out = { ...b };
  if (!weapons.includes(out.weapon) && weapons.length) out.weapon = weapons[0];
  if (!abilities.includes(out.ability1)) out.ability1 = NO_ABILITY;
  if (!abilities.includes(out.ability2) || out.ability2 === out.ability1) out.ability2 = NO_ABILITY;
  return out;
}

export function validBuild(b: Build): boolean {
  if (b.perks < 0 || b.perks >> NODES.length !== 0 || pointsUsed(b.perks) > SKILLS.points) return false;
  for (const n of NODES) if (has(b.perks, n.bit) && n.index > 0 && !has(b.perks, n.bit - 1)) return false;
  const abilities = abilitiesOf(b.perks);
  const slotOk = (a: number) => a === NO_ABILITY || abilities.includes(a);
  return weaponsOf(b.perks).includes(b.weapon) && slotOk(b.ability1) && slotOk(b.ability2) && (b.ability1 !== b.ability2 || b.ability1 === NO_ABILITY);
}

// The next choice for an ability slot: empty, then each learned ability not in the other slot.
export function cycleSlot(b: Build, slot: 1 | 2): Build {
  const other = slot === 1 ? b.ability2 : b.ability1;
  const options = [NO_ABILITY, ...abilitiesOf(b.perks).filter((a) => a !== other)];
  const current = slot === 1 ? b.ability1 : b.ability2;
  const next = options[(options.indexOf(current) + 1) % options.length];
  return slot === 1 ? { ...b, ability1: next } : { ...b, ability2: next };
}

export const abilityName = (a: number) => (a === NO_ABILITY ? 'Empty' : ABILITIES[a].name);

const STORAGE_KEY = 'yggdrasil.build';

export function loadBuild(): Build {
  try {
    const b = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Build | null;
    if (b && validBuild(b)) return b;
  } catch {
    /* nothing saved, or storage unavailable */
  }
  return { ...DEFAULT_BUILD };
}

export function saveBuild(b: Build): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* storage unavailable */
  }
}
