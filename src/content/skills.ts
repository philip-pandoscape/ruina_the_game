import shared from '../../shared/tuning.json' with { type: 'json' };
import treeData from '../../shared/skilltree.json' with { type: 'json' };

// Skills, the tree they live in, the levels the ones you use gain, and the modifiers all of that
// applies.
//
// Everything here is mirrored by crates/engine/src/skills.rs, and the two must agree exactly: the browser
// predicts with these numbers and the server decides with them. That is why the fold order below
// is fixed rather than convenient, and why modifiers are summed per stage before being combined.

// ---------- The tree ----------
//
// The tree's file (shared/skilltree.json) and the levels (tuning.json skills.levels) name a weapon,
// an ability or a movement skill by its id (a weapon's is its name). The rules and the wire know each
// by its place in its list (the order content/<kind>/_order.json gives), so NODES and LEVEL_MODS hold
// the places, found here as they're read, as the engine finds them (crates/engine/src/tuning.rs
// skill_tree); the lists can be in any order.

export interface SkillMod {
  stat: string;
  op: 'flat' | 'inc' | 'more';
  value: number;
  // When this modifier counts. Everything named must match; anything absent is a wildcard.
  tags?: string[]; // the skill being used must carry all of these
  weapon?: number; // the weapon's place in WEAPONS (src/content/tuning.ts)
  skill?: string; // the ability's or movement skill's id
}

export interface SkillGrants {
  weapon?: number; // a weapon's place in WEAPONS
  ability?: number; // an ability's place in ABILITIES, for the hotbar
  movement?: number; // a movement skill's place in MOVEMENT_SKILLS, for a Q / E slot
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

/** A modifier as its file has it: the weapon it changes named by id. */
type ModFile = Omit<SkillMod, 'weapon'> & { weapon?: string };
/** What a node grants as the tree's file has it: each by id. */
type GrantsFile = Omit<SkillGrants, 'weapon' | 'ability' | 'movement'> & { weapon?: string; ability?: string; movement?: string };
type NodeFile = Omit<SkillNode, 'grants' | 'mods'> & { grants?: GrantsFile; mods?: ModFile[] };

const raw = shared.skills as unknown as {
  points: number;
  startPoints: number;
  maxNodes: number;
  trees: Array<{ name: string; color: string }>;
  levels: { xp: number[]; per: Record<string, ModFile[]> };
};
const tree = treeData as unknown as { radii: number[]; nodes: NodeFile[]; links: Array<[string, string, number?]> };

/** The weapons (a weapon's id is its name), abilities and movement skills, in their lists' order, with the tags modifiers look for. */
const WEAPON_DEFS = (shared.weapons as unknown as Array<{ name: string; tags?: string[] }>).map((w) => ({ id: w.name, tags: w.tags ?? [] }));
const ABILITY_DEFS = (shared.abilities as unknown as Array<{ id: string; tags?: string[] }>).map((a) => ({ id: a.id, tags: a.tags ?? [] }));
const MOVEMENT_DEFS = (shared.movementSkills as unknown as Array<{ id: string; tags?: string[] }>).map((m) => ({ id: m.id, tags: m.tags ?? [] }));

/** Where the thing with this id is in its list; one the content hasn't got is a mistake in the file, said with `what`. */
function placeOf(list: ReadonlyArray<{ id: string }>, id: string, what: string): number {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`${what} "${id}", which shared/tuning.json hasn't got`);
  return i;
}

/** A modifier with the place of the weapon it names. */
const placedMod = (m: ModFile, at: string): SkillMod =>
  m.weapon === undefined ? (m as SkillMod) : { ...m, weapon: placeOf(WEAPON_DEFS, m.weapon, `${at} changes the weapon`) };

/** A node of the tree with the places of the weapon, ability or movement skill it grants and of the weapons its modifiers change. */
function placedNode(n: NodeFile): SkillNode {
  const at = `shared/skilltree.json: ${n.id}`;
  const out = { ...n } as unknown as SkillNode;
  if (n.grants) {
    const { weapon, ability, movement } = n.grants;
    const g = { ...n.grants } as unknown as SkillGrants;
    if (weapon !== undefined) g.weapon = placeOf(WEAPON_DEFS, weapon, `${at} grants the weapon`);
    if (ability !== undefined) g.ability = placeOf(ABILITY_DEFS, ability, `${at} grants the ability`);
    if (movement !== undefined) g.movement = placeOf(MOVEMENT_DEFS, movement, `${at} grants the movement skill`);
    out.grants = g;
  }
  if (n.mods) out.mods = n.mods.map((m) => placedMod(m, at));
  return out;
}

/** What a build may spend where nothing else says (the balance harness's duels; a kept build read without its place's points). */
export const SKILL_POINTS = raw.points;
/** What every character starts with in the open world, before quests and milestones add more. */
export const START_POINTS = raw.startPoints;
export const TREES = raw.trees;
export const NODES: readonly SkillNode[] = tree.nodes.map(placedNode);
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

/** The lines between nodes, as index pairs; arc means it is drawn along its orbit. */
export const LINKS: ReadonlyArray<{ a: number; b: number; arc: boolean }> = tree.links.map(([a, b, arc]) => ({
  a: skillIndex(a),
  b: skillIndex(b),
  arc: !!arc,
}));
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

/** Weapons in weapon order, then abilities, then movement skills: the order levels are kept in. */
export const BOOK: readonly BookSkill[] = [
  ...WEAPON_DEFS.map((_, w) => ({ id: NODES.find((n) => n.grants?.weapon === w)?.id ?? `weapon${w}`, kind: 'weapon' as const, index: w })),
  ...ABILITY_DEFS.map((a, i) => ({ id: a.id, kind: 'ability' as const, index: i })),
  ...MOVEMENT_DEFS.map((m, i) => ({ id: m.id, kind: 'movement' as const, index: i })),
];
export const bookIndex = (id: string): number => BOOK.findIndex((b) => b.id === id);

/** Total experience each level needs: LEVEL_XP[0] for level 1 (always 0), and so on up. */
export const LEVEL_XP: readonly number[] = raw.levels.xp;
export const MAX_LEVEL = LEVEL_XP.length;
/** What every level past the first adds, by skill-book id, with the places of the weapons it names. */
export const LEVEL_MODS: Readonly<Record<string, SkillMod[]>> = Object.fromEntries(
  Object.entries(raw.levels.per).map(([id, mods]) => [id, mods.map((m) => placedMod(m, `shared/tuning.json: skills.levels.per.${id}`))]),
);
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
// movement skill, for its cooldown. The engine gathers them (crates/engine/src/skills.rs
// resolve_skills; the page asks it through src/engine/skills.ts): here are their shapes, and what a
// set grants, which the build's checks read.

export interface ResolvedSkills {
  weapon: Channel[][]; // [weapon][stat]
  ability: Channel[][]; // [ability][stat]
  move: Channel[][]; // [movement skill][stat]
  combos: Set<string>; // combo variants this build has unlocked
  weapons: number[]; // weapons it can use
  abilities: number[]; // abilities it has learned
  movement: number[]; // movement skills it has learned
}

/** What a learned set grants, in node order: its combo variants, weapons, abilities and movement skills. */
export function grantsOf(s: SkillSet): Pick<ResolvedSkills, 'combos' | 'weapons' | 'abilities' | 'movement'> {
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
  return { combos, weapons, abilities, movement };
}

/** What a book entry is, to ask which modifiers reach it. */
export function bookContext(b: BookSkill): ModContext {
  if (b.kind === 'weapon') return { weapon: b.index, tags: WEAPON_DEFS[b.index]?.tags ?? [] };
  if (b.kind === 'ability') return { skill: ABILITY_DEFS[b.index]?.id, tags: ABILITY_DEFS[b.index]?.tags ?? [] };
  return { skill: MOVEMENT_DEFS[b.index]?.id, tags: MOVEMENT_DEFS[b.index]?.tags ?? [] };
}
