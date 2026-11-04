import shared from '../shared/tuning.json' with { type: 'json' };
import treeData from '../shared/skilltree.json' with { type: 'json' };

// Skills, the tree they live in, the levels the ones you use gain, and the modifiers all of that
// applies.
//
// Everything here is mirrored by server/src/skills.rs, and the two must agree exactly: the browser
// predicts with these numbers and the server decides with them. That is why the fold order below
// is fixed rather than convenient, and why modifiers are summed per stage before being combined.

// ---------- The tree ----------

export interface SkillMod {
  stat: string;
  op: 'flat' | 'inc' | 'more';
  value: number;
  // When this modifier counts. Everything named must match; anything absent is a wildcard.
  tags?: string[]; // the skill being used must carry all of these
  weapon?: number;
  skill?: string;
}

export interface SkillGrants {
  weapon?: number;
  ability?: number;
  movement?: number; // a movement skill, for a Q / E slot
  combo?: string; // a combo variant on the weapon that owns it
}

/** skill: one of the skills you use or that changes one. The rest are the tree's passives. */
export type NodeKind = 'skill' | 'small' | 'notable' | 'keystone';

export interface SkillNode {
  id: string;
  kind: NodeKind;
  name: string;
  desc?: string;
  icon?: string;
  tree: number; // the discipline, or -1 where two meet
  root?: boolean; // learnable with nothing else learned
  o: number; // orbit
  a: number; // degrees clockwise from up
  tags?: string[];
  grants?: SkillGrants;
  mods?: SkillMod[];
}

const raw = shared.skills as unknown as {
  points: number;
  startPoints: number;
  maxNodes: number;
  trees: Array<{ name: string; color: string }>;
  levels: { xp: number[]; per: Record<string, SkillMod[]> };
};
const tree = treeData as unknown as { radii: number[]; nodes: SkillNode[]; links: Array<[string, string, number?]> };

/** What the training yard and the battlefield may spend. */
export const SKILL_POINTS = raw.points;
/** What every character starts with in the open world, before quests and milestones add more. */
export const START_POINTS = raw.startPoints;
export const TREES = raw.trees;
export const NODES: readonly SkillNode[] = tree.nodes;
export const ORBITS: readonly number[] = tree.radii;
export const MAX_NODES = raw.maxNodes;
// A learned set travels as this many 32-bit words, so the wire size never depends on the tree.
export const SKILL_WORDS = MAX_NODES / 32;

if (NODES.length > MAX_NODES) throw new Error(`skill tree has ${NODES.length} nodes, over maxNodes ${MAX_NODES}`);

const INDEX = new Map(NODES.map((n, i) => [n.id, i]));
export const skillIndex = (id: string): number => {
  const i = INDEX.get(id);
  if (i === undefined) throw new Error(`unknown skill: ${id}`);
  return i;
};
export const nodeAt = (i: number): SkillNode | undefined => NODES[i];

/** The lines between nodes, as index pairs; arc means it is drawn along its orbit. */
export const LINKS: ReadonlyArray<{ a: number; b: number; arc: boolean }> = tree.links.map(([a, b, arc]) => ({ a: skillIndex(a), b: skillIndex(b), arc: !!arc }));
/** Each node's neighbours, in ascending order (both languages walk them the same way). */
export const ADJACENT: readonly number[][] = NODES.map((_, i) => {
  const out: number[] = [];
  for (const l of LINKS) {
    if (l.a === i) out.push(l.b);
    if (l.b === i) out.push(l.a);
  }
  return out.sort((x, y) => x - y);
});
export const ROOTS: readonly number[] = NODES.flatMap((n, i) => (n.root ? [i] : []));

// ---------- The learned set ----------
//
// A fixed-width bitset rather than a single number: a tree meant to grow to hundreds of nodes
// outgrew the 32 bits a JavaScript bitwise operation can hold, never mind the 16 it was sent in.

export type SkillSet = number[]; // SKILL_WORDS unsigned 32-bit words, low bits first

export const emptySkills = (): SkillSet => new Array<number>(SKILL_WORDS).fill(0);
export const cloneSkills = (s: SkillSet): SkillSet => s.slice(0, SKILL_WORDS);

export function hasSkill(s: SkillSet, index: number): boolean {
  if (index < 0 || index >= MAX_NODES) return false;
  return ((s[index >>> 5] ?? 0) & (1 << (index & 31))) !== 0;
}

export function withSkill(s: SkillSet, index: number, on: boolean): SkillSet {
  const out = cloneSkills(s);
  if (index < 0 || index >= MAX_NODES) return out;
  const w = index >>> 5;
  const bit = 1 << (index & 31);
  out[w] = (on ? (out[w] ?? 0) | bit : (out[w] ?? 0) & ~bit) >>> 0;
  return out;
}

export function skillCount(s: SkillSet): number {
  let n = 0;
  for (let w = 0; w < SKILL_WORDS; w++) {
    let v = s[w] ?? 0;
    while (v) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}

// Builds a set from node ids, for tests and for seeding a default build.
export function skillsFrom(...ids: string[]): SkillSet {
  let out = emptySkills();
  for (const id of ids) out = withSkill(out, skillIndex(id), true);
  return out;
}

export const learnedIds = (s: SkillSet): string[] => NODES.filter((_, i) => hasSkill(s, i)).map((n) => n.id);

// Normalises anything that came off the wire or out of storage to the right width.
export function toSkillSet(v: unknown): SkillSet {
  const out = emptySkills();
  if (Array.isArray(v)) {
    for (let w = 0; w < SKILL_WORDS; w++) out[w] = (Number(v[w]) || 0) >>> 0;
  } else if (typeof v === 'number' && Number.isFinite(v)) {
    // A build saved when the whole set was one number.
    out[0] = v >>> 0;
  }
  return out;
}

// ---------- Where you can go ----------
//
// You learn outward from where the tree starts: a node is open to you when it is a root or touches
// one you've learned, and what you've learned must always hang together back to a root.

/** The learned nodes a root reaches through learned nodes, leaving out `without`. */
function reached(s: SkillSet, without = -1): boolean[] {
  const seen = NODES.map(() => false);
  const queue: number[] = [];
  for (const r of ROOTS) {
    if (r !== without && hasSkill(s, r)) {
      seen[r] = true;
      queue.push(r);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    for (const n of ADJACENT[queue[q]]) {
      if (seen[n] || n === without || !hasSkill(s, n)) continue;
      seen[n] = true;
      queue.push(n);
    }
  }
  return seen;
}

/** Whether a node is open to learn: a root, or next to something learned. */
export function reachable(s: SkillSet, index: number): boolean {
  const n = NODES[index];
  if (!n) return false;
  return !!n.root || ADJACENT[index].some((j) => hasSkill(s, j));
}

// Everything that would be cut off if `index` were unlearned, including itself.
export function dependents(s: SkillSet, index: number): number[] {
  if (!hasSkill(s, index)) return [];
  const still = reached(s, index);
  return NODES.flatMap((_, i) => (hasSkill(s, i) && (i === index || !still[i]) ? [i] : []));
}

// A set is sound when everything learned hangs together back to a root.
export function soundTree(s: SkillSet): boolean {
  for (let i = NODES.length; i < MAX_NODES; i++) if (hasSkill(s, i)) return false;
  const seen = reached(s);
  return NODES.every((_, i) => !hasSkill(s, i) || seen[i]);
}

/**
 * The cheapest way to `index` from what you've learned: the nodes to learn, nearest first, ending
 * with it. Empty if it is already learned. Ties go to the lower index, the same on every machine.
 */
export function pathTo(s: SkillSet, index: number): number[] {
  if (index < 0 || index >= NODES.length || hasSkill(s, index)) return [];
  const prev = new Map<number, number>();
  const queue: number[] = [];
  // Start from every open node: one step away from what you have.
  for (let i = 0; i < NODES.length; i++) {
    if (!hasSkill(s, i) && reachable(s, i)) {
      prev.set(i, -1);
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const at = queue[q];
    if (at === index) break;
    for (const n of ADJACENT[at]) {
      if (prev.has(n) || hasSkill(s, n)) continue;
      prev.set(n, at);
      queue.push(n);
    }
  }
  if (!prev.has(index)) return [];
  const out: number[] = [];
  for (let at = index; at >= 0; at = prev.get(at)!) out.push(at);
  return out.reverse();
}

// ---------- Modifiers ----------
//
// Three stages, in this order and no other:
//     (base + Σflat) × (1 + Σinc) × Π(1 + more)
// Sums are gathered before they are used, so the order modifiers arrive in cannot change the
// result. The products are taken in node order, which both languages read from the same file.

export interface StatDef {
  id: string;
  base?: number;
  desc?: string;
}

export const STATS = shared.stats as unknown as StatDef[];
const STAT_INDEX = new Map(STATS.map((s, i) => [s.id, i]));
export const statIndex = (id: string): number => {
  const i = STAT_INDEX.get(id);
  if (i === undefined) throw new Error(`unknown stat: ${id}`);
  return i;
};
export const statBase = (i: number): number => STATS[i]?.base ?? 0;

// What a skill or swing is, for deciding which modifiers apply.
export interface ModContext {
  tags?: readonly string[];
  weapon?: number;
  skill?: string;
}

const applies = (m: SkillMod, c: ModContext): boolean => {
  if (m.weapon !== undefined && m.weapon !== c.weapon) return false;
  if (m.skill !== undefined && m.skill !== c.skill) return false;
  if (m.tags && !m.tags.every((t) => c.tags?.includes(t))) return false;
  return true;
};
/** Whether a modifier reaches a skill or swing (the skill book lists what changes each skill). */
export const modApplies = applies;

// The three accumulated stages for one stat, ready to apply to any base.
export interface Channel {
  flat: number;
  inc: number;
  more: number; // already multiplied out
}

const IDENTITY: Channel = { flat: 0, inc: 0, more: 1 };

export function gather(s: SkillSet, ctx: ModContext, levels?: Levels): Channel[] {
  const out: Channel[] = STATS.map(() => ({ flat: 0, inc: 0, more: 1 }));
  // Node order, so the product below is the same sequence on both sides.
  for (let i = 0; i < NODES.length; i++) {
    if (!hasSkill(s, i)) continue;
    for (const m of NODES[i].mods ?? []) {
      if (!applies(m, ctx)) continue;
      const c = out[statIndex(m.stat)];
      if (m.op === 'flat') c.flat += m.value;
      else if (m.op === 'inc') c.inc += m.value;
      else c.more *= 1 + m.value;
    }
  }
  // Then what each skill's levels add, once per level past the first. Sums only, so the order
  // they come in doesn't matter.
  if (levels) {
    for (let b = 0; b < BOOK.length; b++) {
      const extra = (levels[b] ?? 1) - 1;
      if (extra <= 0) continue;
      for (const m of LEVEL_MODS[BOOK[b].id] ?? []) {
        if (!applies(m, ctx)) continue;
        const c = out[statIndex(m.stat)];
        if (m.op === 'flat') c.flat += m.value * extra;
        else c.inc += m.value * extra;
      }
    }
  }
  return out;
}

export const applyChannel = (c: Channel | undefined, base: number): number => {
  const ch = c ?? IDENTITY;
  return (base + ch.flat) * (1 + ch.inc) * ch.more;
};

// Frame counts are whole numbers; both languages round the same way.
export const applyFrames = (c: Channel | undefined, base: number): number => Math.max(0, Math.round(applyChannel(c, base)));

// ---------- The skill book: what levels up ----------
//
// Every weapon, ability and movement skill gains experience as you use it (a weapon for each hit it
// lands, an ability for each cast, a movement skill each time you use it) and a level at each step
// of the curve. What a level adds is data too: tuning.json skills.levels.

export type BookKind = 'weapon' | 'ability' | 'movement';
export interface BookSkill {
  id: string; // the tree node that grants the weapon, or the ability / movement skill's id
  kind: BookKind;
  index: number; // weapon, ability or movement skill index
}

const ABILITY_IDS = (shared.abilities as unknown as Array<{ id: string; tags?: string[] }>).map((a) => ({
  id: a.id,
  tags: a.tags ?? [],
}));
const MOVEMENT_DEFS = (shared.movementSkills as unknown as Array<{ id: string; tags?: string[] }>).map((m) => ({ id: m.id, tags: m.tags ?? [] }));
const WEAPON_TAGS = (shared.weapons as unknown as Array<{ tags?: string[] }>).map((w) => w.tags ?? []);

/** Weapons in weapon order, then abilities, then movement skills: the order levels are kept in. */
export const BOOK: readonly BookSkill[] = [
  ...WEAPON_TAGS.map((_, w) => ({ id: NODES.find((n) => n.grants?.weapon === w)?.id ?? `weapon${w}`, kind: 'weapon' as const, index: w })),
  ...ABILITY_IDS.map((a, i) => ({ id: a.id, kind: 'ability' as const, index: i })),
  ...MOVEMENT_DEFS.map((m, i) => ({ id: m.id, kind: 'movement' as const, index: i })),
];
export const bookIndex = (id: string): number => BOOK.findIndex((b) => b.id === id);

/** Total experience each level needs: LEVEL_XP[0] for level 1 (always 0), and so on up. */
export const LEVEL_XP: readonly number[] = raw.levels.xp;
export const MAX_LEVEL = LEVEL_XP.length;
export const LEVEL_MODS: Readonly<Record<string, SkillMod[]>> = raw.levels.per;
for (const [id, mods] of Object.entries(LEVEL_MODS)) {
  if (bookIndex(id) < 0) throw new Error(`skills.levels.per names "${id}", which isn't in the skill book`);
  if (mods.some((m) => m.op === 'more')) throw new Error(`skills.levels.per.${id}: levels add flat or inc, never more`);
}

/** A level per BOOK entry, 1..MAX_LEVEL. */
export type Levels = number[];

export function levelOf(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= LEVEL_XP[level]) level++;
  return level;
}

/** Levels from experience kept by skill id (the island's skillXp). */
export const levelsFrom = (xp: Readonly<Record<string, number>> | undefined): Levels => BOOK.map((b) => levelOf(xp?.[b.id] ?? 0));

export const sameLevels = (a: Levels | undefined, b: Levels | undefined): boolean => {
  for (let i = 0; i < BOOK.length; i++) if ((a?.[i] ?? 1) !== (b?.[i] ?? 1)) return false;
  return true;
};

// ---------- Resolved per build ----------
//
// Gathering walks the whole tree, so it happens once when a build or a level changes and never in
// a frame. The result is a set of channels per weapon, for swings; per ability, for casts; and per
// movement skill, for its cooldown.

export interface ResolvedSkills {
  weapon: Channel[][]; // [weapon][stat]
  ability: Channel[][]; // [ability][stat]
  move: Channel[][]; // [movement skill][stat]
  combos: Set<string>; // combo variants this build has unlocked
  weapons: number[]; // weapons it can use
  abilities: number[]; // abilities it has learned
  movement: number[]; // movement skills it has learned
}

export function resolveSkills(s: SkillSet, levels?: Levels): ResolvedSkills {
  const combos = new Set<string>();
  const weapons: number[] = [];
  const abilities: number[] = [];
  const movement: number[] = [];
  for (let i = 0; i < NODES.length; i++) {
    if (!hasSkill(s, i)) continue;
    const g = NODES[i].grants;
    if (!g) continue;
    if (g.combo) combos.add(g.combo);
    if (g.weapon !== undefined) weapons.push(g.weapon);
    if (g.ability !== undefined) abilities.push(g.ability);
    if (g.movement !== undefined) movement.push(g.movement);
  }
  const weapon = WEAPON_TAGS.map((tags, w) => gather(s, { weapon: w, tags }, levels));
  const ability = ABILITY_IDS.map((a) => gather(s, { skill: a.id, tags: a.tags }, levels));
  const move = MOVEMENT_DEFS.map((m) => gather(s, { skill: m.id, tags: m.tags }, levels));
  return { weapon, ability, move, combos, weapons, abilities, movement };
}

export const abilityTags = (a: number): readonly string[] => ABILITY_IDS[a]?.tags ?? [];

/** What a book entry is, to ask which modifiers reach it. */
export function bookContext(b: BookSkill): ModContext {
  if (b.kind === 'weapon') return { weapon: b.index, tags: WEAPON_TAGS[b.index] ?? [] };
  if (b.kind === 'ability') return { skill: ABILITY_IDS[b.index]?.id, tags: ABILITY_IDS[b.index]?.tags ?? [] };
  return { skill: MOVEMENT_DEFS[b.index]?.id, tags: MOVEMENT_DEFS[b.index]?.tags ?? [] };
}
export const abilityId = (a: number): string => ABILITY_IDS[a]?.id ?? '';
