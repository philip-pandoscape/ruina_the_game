import {
  ADJACENT,
  dependents,
  emptySkills,
  hasSkill,
  NODES,
  reachable,
  resolveSkills,
  ROOTS,
  SKILL_POINTS,
  skillCount,
  soundTree,
  toSkillSet,
  withSkill,
  type SkillNode,
  type SkillSet,
} from './skills';
import { DEFAULT_BUILD, emptyHotbar, emptyMovement, HOTBAR_SLOTS, MOVEMENT_SKILLS, MOVEMENT_SLOTS, NO_ABILITY, NO_MOVEMENT, type Build } from './tuning';

// Picking a build: learning outward through the tree, and filling the hotbar from what you've
// learned. crates/engine/src/skills.rs checks the same rules, so a build that passes here is accepted
// there. How many points you may spend depends on where you are: the training yard and the
// battlefield allow SKILL_POINTS; the open world allows what you've earned (src/engine/life/quests.ts).

export interface NodeInfo {
  index: number;
  tree: number;
  id: string;
  node: SkillNode;
}

export const NODE_INFO: NodeInfo[] = NODES.map((node, index) => ({ index, tree: node.tree, id: node.id, node }));

export const has = (b: Build, index: number): boolean => hasSkill(b.skills, index);
export const pointsUsed = (s: SkillSet): number => skillCount(s);
export const pointsLeft = (s: SkillSet, budget = SKILL_POINTS): number => budget - skillCount(s);

export const weaponsOf = (s: SkillSet): number[] => resolveSkills(s).weapons;

// Why a skill can't be learned right now, or null if it can.
export function learnBlock(b: Build, info: NodeInfo, budget = SKILL_POINTS): string | null {
  if (has(b, info.index)) return 'Already learned';
  if (!reachable(b.skills, info.index)) {
    // Name the skills next to it that you could learn now.
    const next = ADJACENT[info.index].filter((j) => NODES[j].kind === 'skill' && reachable(b.skills, j)).map((j) => NODES[j].name);
    return next.length ? `Learn ${next.join(' or ')} first` : 'Learn a skill next to it first';
  }
  if (pointsLeft(b.skills, budget) <= 0) return 'No skill points left';
  return null;
}

/** Learns a whole planned path, nearest first; null if any step isn't allowed. */
export function learnPath(b: Build, path: readonly number[], budget = SKILL_POINTS): Build | null {
  let out = b;
  for (const i of path) {
    if (learnBlock(out, NODE_INFO[i], budget)) return null;
    out = learn(out, NODE_INFO[i]);
  }
  return out;
}

// Why a skill can't be unlearned, or null if it can. Unlearning also drops anything that needed it.
export function unlearnBlock(b: Build, info: NodeInfo): string | null {
  if (!has(b, info.index)) return 'Not learned';
  if (weaponsOf(dropFrom(b.skills, info.index)).length === 0) return 'Keep at least one weapon skill';
  return null;
}

function dropFrom(s: SkillSet, index: number): SkillSet {
  let out = s;
  for (const i of dependents(s, index)) out = withSkill(out, i, false);
  return out;
}

// How many other skills would go with this one.
export const alsoDropped = (b: Build, info: NodeInfo): number => dependents(b.skills, info.index).length - 1;

export function learn(b: Build, info: NodeInfo): Build {
  const next = fixLoadout({ ...b, skills: withSkill(b.skills, info.index, true) });
  // A newly learned ability goes straight into the first free hotbar slot.
  const a = info.node.grants?.ability;
  if (a !== undefined && !next.abilities.includes(a)) {
    const free = next.abilities.indexOf(NO_ABILITY);
    if (free >= 0) next.abilities[free] = a;
  }
  const m = info.node.grants?.movement;
  if (m !== undefined && !next.movement.includes(m)) {
    const free = next.movement.indexOf(NO_MOVEMENT);
    if (free >= 0) next.movement[free] = m;
  }
  return next;
}

export function unlearn(b: Build, info: NodeInfo): Build {
  return fixLoadout({ ...b, skills: dropFrom(b.skills, info.index) });
}

// Puts an ability in a slot (or clears it with NO_ABILITY). An ability already sitting in another
// slot moves rather than being duplicated, swapping with whatever was where it's going.
export function assignSlot(b: Build, slot: number, ability: number): Build {
  if (slot < 0 || slot >= HOTBAR_SLOTS) return b;
  const abilities = [...b.abilities];
  const from = ability === NO_ABILITY ? -1 : abilities.indexOf(ability);
  const displaced = abilities[slot];
  abilities[slot] = ability;
  if (from >= 0 && from !== slot) abilities[from] = displaced;
  return { ...b, abilities };
}

// Drag and drop: exchange two slots.
export function swapSlots(b: Build, a: number, c: number): Build {
  if (a < 0 || c < 0 || a >= HOTBAR_SLOTS || c >= HOTBAR_SLOTS || a === c) return b;
  const abilities = [...b.abilities];
  [abilities[a], abilities[c]] = [abilities[c], abilities[a]];
  return { ...b, abilities };
}

// Keeps the loadout to things you've actually learned.
export function fixLoadout(b: Build): Build {
  const r = resolveSkills(b.skills);
  const out: Build = { ...b, skills: b.skills, abilities: [...(b.abilities ?? [])], movement: [...(b.movement ?? [])] };
  while (out.movement.length < MOVEMENT_SLOTS) out.movement.push(NO_MOVEMENT);
  out.movement.length = MOVEMENT_SLOTS;
  const seenMove = new Set<number>();
  for (let i = 0; i < MOVEMENT_SLOTS; i++) {
    const m = out.movement[i];
    if (m === NO_MOVEMENT) continue;
    if (!r.movement.includes(m) || seenMove.has(m)) out.movement[i] = NO_MOVEMENT;
    else seenMove.add(m);
  }
  while (out.abilities.length < HOTBAR_SLOTS) out.abilities.push(NO_ABILITY);
  out.abilities.length = HOTBAR_SLOTS;
  if (!r.weapons.includes(out.weapon) && r.weapons.length) out.weapon = r.weapons[0];
  // Drop anything you haven't learned, and any ability that somehow ended up in two slots.
  const seen = new Set<number>();
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const a = out.abilities[i];
    if (a === NO_ABILITY) continue;
    if (!r.abilities.includes(a) || seen.has(a)) out.abilities[i] = NO_ABILITY;
    else seen.add(a);
  }
  return out;
}

export function validBuild(b: Build, budget = SKILL_POINTS): boolean {
  if (!Array.isArray(b.skills) || !soundTree(b.skills)) return false;
  if (pointsUsed(b.skills) > budget) return false;
  if (!Array.isArray(b.abilities) || b.abilities.length !== HOTBAR_SLOTS) return false;
  if (!Array.isArray(b.movement) || b.movement.length !== MOVEMENT_SLOTS) return false;
  const r = resolveSkills(b.skills);
  const seen = new Set<number>();
  for (const a of b.abilities) {
    if (a === NO_ABILITY) continue;
    if (!r.abilities.includes(a) || seen.has(a)) return false; // not learned, or in two slots at once
    seen.add(a);
  }
  const seenMove = new Set<number>();
  for (const m of b.movement) {
    if (m === NO_MOVEMENT) continue;
    if (!r.movement.includes(m) || seenMove.has(m)) return false;
    seenMove.add(m);
  }
  return r.weapons.includes(b.weapon);
}

export function defaultBuild(): Build {
  return { ...DEFAULT_BUILD, skills: [...DEFAULT_BUILD.skills], abilities: emptyHotbar(), movement: emptyMovement() };
}

/** A build as stored (here or on the server), carried forward from older shapes; null if it no longer holds together. */
export function parseBuild(raw: unknown, budget = SKILL_POINTS): Build | null {
  if (!raw || typeof raw !== 'object') return null;
  try {
    const b = migrate(raw as Record<string, unknown>);
    return b && validBuild(b, budget) ? b : null;
  } catch {
    return null;
  }
}

// Builds saved before the tree became a graph kept their skills in one number and their abilities
// in two named slots. Carry both forward rather than throwing away someone's loadout.
function migrate(raw: Record<string, unknown>): Build | null {
  if (typeof raw.weapon !== 'number') return null;
  const skills = toSkillSet(raw.skills ?? raw.perks);
  const abilities = Array.isArray(raw.abilities) ? [...(raw.abilities as number[])] : emptyHotbar();
  if (!Array.isArray(raw.abilities)) {
    if (typeof raw.ability1 === 'number') abilities[0] = raw.ability1;
    if (typeof raw.ability2 === 'number') abilities[1] = raw.ability2;
  }
  // An old set may name skills that have since moved or gone; keep only what still hangs together
  // back to where the tree starts.
  let kept = emptySkills();
  const queue = ROOTS.filter((r) => hasSkill(skills, r));
  for (const r of queue) kept = withSkill(kept, r, true);
  for (let q = 0; q < queue.length; q++) {
    for (const n of ADJACENT[queue[q]]) {
      if (hasSkill(kept, n) || !hasSkill(skills, n)) continue;
      kept = withSkill(kept, n, true);
      queue.push(n);
    }
  }
  const movement = Array.isArray(raw.movement) ? [...(raw.movement as number[])] : emptyMovement();
  return fixLoadout({ skills: kept, weapon: raw.weapon, abilities, movement });
}

// Puts a movement skill in a Q / E slot (or clears it). Like the hotbar, it moves rather than
// duplicates.
export function assignMovement(b: Build, slot: number, skill: number): Build {
  if (slot < 0 || slot >= MOVEMENT_SLOTS) return b;
  const movement = [...b.movement];
  const from = skill === NO_MOVEMENT ? -1 : movement.indexOf(skill);
  const displaced = movement[slot];
  movement[slot] = skill;
  if (from >= 0 && from !== slot) movement[from] = displaced;
  return { ...b, movement };
}

export const movementName = (m: number) => (m === NO_MOVEMENT ? 'Empty' : (MOVEMENT_SKILLS[m]?.name ?? 'Empty'));
