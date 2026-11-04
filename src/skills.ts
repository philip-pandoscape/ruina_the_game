import shared from '../shared/tuning.json' with { type: 'json' };

// Skills, the tree they live in, and the modifiers they apply.
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

export interface SkillNode {
  id: string;
  name: string;
  desc: string;
  icon: string;
  tree: number;
  requires: string[];
  tags?: string[];
  grants?: SkillGrants;
  mods?: SkillMod[];
}

const raw = shared.skills as unknown as {
  points: number;
  maxNodes: number;
  trees: Array<{ name: string }>;
  nodes: SkillNode[];
};

export const SKILL_POINTS = raw.points;
export const TREES = raw.trees;
export const NODES: readonly SkillNode[] = raw.nodes;
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

// Builds a set from skill ids, for tests and for seeding a default build.
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

// ---------- Prerequisites ----------
//
// A node needs every skill it lists. Requirements are a graph, not a column, so a node can sit
// behind two branches at once and trees can merge later without changing any of this.

export function requirementsMet(s: SkillSet, index: number): boolean {
  const n = NODES[index];
  if (!n) return false;
  return n.requires.every((id) => hasSkill(s, skillIndex(id)));
}

// Everything that would be stranded if `index` were unlearned, including itself.
export function dependents(s: SkillSet, index: number): number[] {
  const doomed = new Set<number>([index]);
  // Repeat until nothing new falls: a node drops once any requirement of it has dropped.
  for (let pass = 0; pass < NODES.length; pass++) {
    let grew = false;
    NODES.forEach((n, i) => {
      if (doomed.has(i) || !hasSkill(s, i)) return;
      if (n.requires.some((id) => doomed.has(skillIndex(id)))) {
        doomed.add(i);
        grew = true;
      }
    });
    if (!grew) break;
  }
  return [...doomed].filter((i) => hasSkill(s, i)).sort((a, b) => a - b);
}

// A set is sound when every learned node's requirements are also learned.
export const soundTree = (s: SkillSet): boolean => NODES.every((_, i) => !hasSkill(s, i) || requirementsMet(s, i));

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

// The three accumulated stages for one stat, ready to apply to any base.
export interface Channel {
  flat: number;
  inc: number;
  more: number; // already multiplied out
}

const IDENTITY: Channel = { flat: 0, inc: 0, more: 1 };

export function gather(s: SkillSet, ctx: ModContext): Channel[] {
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
  return out;
}

export const applyChannel = (c: Channel | undefined, base: number): number => {
  const ch = c ?? IDENTITY;
  return (base + ch.flat) * (1 + ch.inc) * ch.more;
};

// Frame counts are whole numbers; both languages round the same way.
export const applyFrames = (c: Channel | undefined, base: number): number => Math.max(0, Math.round(applyChannel(c, base)));

// ---------- Resolved per build ----------
//
// Gathering walks the whole tree, so it happens once when a build changes and never in a frame.
// The result is two sets of channels: one per weapon, for swings, and one per ability, for casts.

export interface ResolvedSkills {
  weapon: Channel[][]; // [weapon][stat]
  ability: Channel[][]; // [ability][stat]
  combos: Set<string>; // combo variants this build has unlocked
  weapons: number[]; // weapons it can use
  abilities: number[]; // abilities it has learned
  movement: number[]; // movement skills it has learned
}

// Identity comes straight out of the same file, so this stays free of any import cycle with
// the tables that describe what an ability or a weapon actually does.
const ABILITY_IDS = (shared.abilities as unknown as Array<{ id: string; tags?: string[] }>).map((a) => ({
  id: a.id,
  tags: a.tags ?? [],
}));
const WEAPON_TAGS = (shared.weapons as unknown as Array<{ tags?: string[] }>).map((w) => w.tags ?? []);

export function resolveSkills(s: SkillSet): ResolvedSkills {
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
  const weapon = WEAPON_TAGS.map((tags, w) => gather(s, { weapon: w, tags }));
  const ability = ABILITY_IDS.map((a) => gather(s, { skill: a.id, tags: a.tags }));
  return { weapon, ability, combos, weapons, abilities, movement };
}

export const abilityTags = (a: number): readonly string[] => ABILITY_IDS[a]?.tags ?? [];
export const abilityId = (a: number): string => ABILITY_IDS[a]?.id ?? '';
