import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  applyChannel,
  applyFrames,
  dependents,
  emptySkills,
  gather,
  hasSkill,
  MAX_NODES,
  NODES,
  requirementsMet,
  resolveSkills,
  SKILL_WORDS,
  skillCount,
  skillIndex,
  skillsFrom,
  soundTree,
  statIndex,
  toSkillSet,
  withSkill,
  type SkillMod,
} from '../src/skills';
import { castFramesFor, comboFor, meleeTargets, pierceTargets, WEAPONS } from '../src/tuning';

const BALANCE = `server/target/release/balance${process.platform === 'win32' ? '.exe' : ''}`;

// The skill architecture itself: the set, the graph, and the modifier fold. These are the
// properties a growing tree leans on, so they are checked directly rather than through a fight.

// ---------- The learned set ----------

test('the set holds far more skills than a single number could', () => {
  expect(MAX_NODES).toBeGreaterThanOrEqual(256);
  expect(SKILL_WORDS * 32).toBe(MAX_NODES);
  // The old representation was one 32-bit number sent as 16 bits. Prove both are behind us.
  let s = emptySkills();
  for (const i of [0, 31, 32, 33, 64, 200, MAX_NODES - 1]) s = withSkill(s, i, true);
  for (const i of [0, 31, 32, 33, 64, 200, MAX_NODES - 1]) expect(hasSkill(s, i)).toBe(true);
  expect(hasSkill(s, 100)).toBe(false);
  expect(skillCount(s)).toBe(7);
});

test('setting a bit leaves the rest of the set alone', () => {
  let s = withSkill(emptySkills(), 40, true);
  s = withSkill(s, 41, true);
  s = withSkill(s, 40, false);
  expect([hasSkill(s, 40), hasSkill(s, 41)]).toEqual([false, true]);
  expect(skillCount(s)).toBe(1);
});

test('out-of-range bits are ignored rather than corrupting a neighbour', () => {
  const s = withSkill(withSkill(emptySkills(), -1, true), MAX_NODES + 5, true);
  expect(skillCount(s)).toBe(0);
  expect(hasSkill(s, -1)).toBe(false);
});

test('a set saved as one number still loads', () => {
  const old = (1 << 0) | (1 << 3); // sword and club, as the first version stored them
  const s = toSkillSet(old);
  expect(s).toHaveLength(SKILL_WORDS);
  expect([hasSkill(s, 0), hasSkill(s, 3), hasSkill(s, 1)]).toEqual([true, true, false]);
});

// ---------- The graph ----------

test('every node in the data names requirements that exist', () => {
  for (const n of NODES) {
    for (const id of n.requires) expect(() => skillIndex(id), `${n.id} requires ${id}`).not.toThrow();
  }
});

test('a node needs all of its requirements, not just one', () => {
  const whirlwind = skillIndex('whirlwind'); // requires cleave, which requires sword
  expect(requirementsMet(skillsFrom('sword'), whirlwind)).toBe(false);
  expect(requirementsMet(skillsFrom('sword', 'cleave'), whirlwind)).toBe(true);
});

test('unlearning takes everything that stood on it', () => {
  const s = skillsFrom('sword', 'cleave', 'whirlwind', 'club');
  const dropped = dependents(s, skillIndex('cleave')).map((i) => NODES[i].id);
  expect(dropped.sort()).toEqual(['cleave', 'whirlwind']); // not sword, not the other tree
  expect(dependents(s, skillIndex('club')).map((i) => NODES[i].id)).toEqual(['club']);
});

test('a set with a missing requirement is not sound', () => {
  expect(soundTree(skillsFrom('sword', 'cleave'))).toBe(true);
  const broken = withSkill(emptySkills(), skillIndex('cleave'), true); // cleave without sword
  expect(soundTree(broken)).toBe(false);
});

// ---------- The modifier fold ----------

// Gathers a made-up set of modifiers the way the real resolver would, so the arithmetic can be
// checked without inventing skills in the shared data.
function fold(mods: Array<Pick<SkillMod, 'op' | 'value'>>, base: number): number {
  let flat = 0;
  let inc = 0;
  let more = 1;
  for (const m of mods) {
    if (m.op === 'flat') flat += m.value;
    else if (m.op === 'inc') inc += m.value;
    else more *= 1 + m.value;
  }
  return applyChannel({ flat, inc, more }, base);
}

test('the three stages apply in the documented order', () => {
  // (100 + 10) × (1 + 0.5) × 1.2 = 198, and not any other grouping.
  expect(fold([{ op: 'flat', value: 10 }, { op: 'inc', value: 0.5 }, { op: 'more', value: 0.2 }], 100)).toBeCloseTo(198, 9);
  // Were "more" treated as another increase it would be 170; were flat applied last, 160 + ...
  expect(fold([{ op: 'flat', value: 10 }, { op: 'inc', value: 0.5 }, { op: 'more', value: 0.2 }], 100)).not.toBeCloseTo(170, 6);
});

test('sums do not care what order they arrive in, which is what keeps the two sims equal', () => {
  const mods: Array<Pick<SkillMod, 'op' | 'value'>> = [
    { op: 'inc', value: 0.3 },
    { op: 'flat', value: 7 },
    { op: 'inc', value: 0.15 },
    { op: 'flat', value: -2 },
  ];
  const forwards = fold(mods, 50);
  const backwards = fold([...mods].reverse(), 50);
  expect(forwards).toBe(backwards);
});

test('increases add together while multipliers compound', () => {
  // Two 50% increases are +100%; two 50% multipliers are ×2.25.
  expect(fold([{ op: 'inc', value: 0.5 }, { op: 'inc', value: 0.5 }], 10)).toBeCloseTo(20, 9);
  expect(fold([{ op: 'more', value: 0.5 }, { op: 'more', value: 0.5 }], 10)).toBeCloseTo(22.5, 9);
});

test('frames round the same way every time', () => {
  expect(applyFrames({ flat: 0, inc: 0, more: 0.6 }, 24)).toBe(14); // 14.4
  expect(applyFrames({ flat: 0, inc: 0, more: 0.7 }, 72)).toBe(50); // 50.4
  expect(applyFrames({ flat: 0, inc: 0, more: 1 }, 9)).toBe(9);
  expect(applyFrames({ flat: -100, inc: 0, more: 1 }, 9)).toBe(0); // never negative
});

test('a modifier only counts where it is scoped to', () => {
  const s = skillsFrom('bow', 'rapidFire'); // scoped to weapon 3
  const startup = statIndex('attack.startup');
  expect(gather(s, { weapon: 3, tags: WEAPONS[3].tags })[startup].more).toBeLessThan(1);
  expect(gather(s, { weapon: 0, tags: WEAPONS[0].tags })[startup].more).toBe(1);
});

test('a tag-scoped modifier only reaches skills carrying that tag', () => {
  const s = skillsFrom('club', 'heal', 'swiftMending'); // scoped to the heal tag
  const r = resolveSkills(s);
  const cast = statIndex('cast.frames');
  expect(r.ability[0][cast].more).toBeLessThan(1); // Healing Circle
  expect(r.ability[1][cast].more).toBe(1); // Meteor, untouched
});

// ---------- What the old named perks became ----------

test('the skills that used to be special cases still do what they say', () => {
  const plain = resolveSkills(skillsFrom('sword'));
  const cleaver = resolveSkills(skillsFrom('sword', 'cleave'));
  expect(meleeTargets(0, plain)).toBe(1);
  expect(meleeTargets(0, cleaver)).toBe(6);
  expect(meleeTargets(1, cleaver)).toBe(1); // scoped to the sword

  const archer = resolveSkills(skillsFrom('bow'));
  const piercer = resolveSkills(skillsFrom('bow', 'rapidFire', 'piercing'));
  expect(pierceTargets(3, archer)).toBe(1);
  expect(pierceTargets(3, piercer)).toBe(3);
  // "a third faster": 9 frames of draw become 6.
  expect(comboFor(3, archer)[0].startup).toBe(9);
  expect(comboFor(3, piercer)[0].startup).toBe(6);

  // "40% faster" and "30% faster" land on the old hand-written numbers exactly.
  expect(castFramesFor(0, resolveSkills(skillsFrom('club', 'heal')))).toBe(24);
  expect(castFramesFor(0, resolveSkills(skillsFrom('club', 'heal', 'swiftMending')))).toBe(14);
  expect(castFramesFor(1, resolveSkills(skillsFrom('staff', 'meteor')))).toBe(72);
  expect(castFramesFor(1, resolveSkills(skillsFrom('staff', 'meteor', 'quickIncantation')))).toBe(50);
});

test('Whirlwind swaps the third sword hit rather than scaling a number', () => {
  const base = comboFor(0, resolveSkills(skillsFrom('sword', 'cleave')));
  const spin = comboFor(0, resolveSkills(skillsFrom('sword', 'cleave', 'whirlwind')));
  expect(spin).toHaveLength(base.length);
  expect(spin.slice(0, 2)).toEqual(base.slice(0, 2)); // the first two are untouched
  expect(spin[2].arcDeg).toBe(360);
  expect(spin[2].pose).toBe('spin'); // and the renderer is told from the data, not by name
  expect(base[2].pose).toBeUndefined();
});

test('grants are collected from the tree, not hardcoded anywhere', () => {
  const r = resolveSkills(skillsFrom('sword', 'club', 'heal', 'staff', 'meteor'));
  expect([...r.weapons].sort()).toEqual([0, 1, 2]);
  expect([...r.abilities].sort()).toEqual([0, 1]);
  expect(r.combos.size).toBe(0);
  expect(resolveSkills(skillsFrom('sword', 'cleave', 'whirlwind')).combos.has('whirlwind')).toBe(true);
});

test('resolving an empty build gives the untouched numbers', () => {
  const none = resolveSkills(emptySkills());
  expect(comboFor(0, none).map((s) => s.damage)).toEqual(WEAPONS[0].combo.map((s) => s.damage));
  expect(meleeTargets(0, none)).toBe(1);
  expect(castFramesFor(1, none)).toBe(72);
});

// ---------- End to end, through the real rules ----------

// The balance harness runs builds against each other under the server's own hit resolution, so
// this is the last link in the chain: a modifier in the data actually changes a fight.
test('a skill upgrade beats the build it upgrades, measured through the server rules', () => {
  test.skip(!existsSync(BALANCE), 'build it first: cargo build --release --manifest-path server/Cargo.toml --bin balance');
  const scenario = {
    duels: 6,
    seed: 3,
    maxSeconds: 25,
    startDistance: 8,
    builds: [
      { name: 'mage', skills: ['staff', 'meteor'], weapon: 2, abilities: ['meteor'] },
      { name: 'quick', skills: ['staff', 'meteor', 'quickIncantation'], weapon: 2, abilities: ['meteor'] },
      { name: 'healer', skills: ['club', 'heal'], weapon: 1, abilities: ['heal'] },
      { name: 'mender', skills: ['club', 'heal', 'swiftMending'], weapon: 1, abilities: ['heal'] },
      { name: 'archer', skills: ['bow'], weapon: 3, abilities: [] },
      { name: 'rapid', skills: ['bow', 'rapidFire'], weapon: 3, abilities: [] },
    ],
  };
  const out = JSON.parse(execFileSync(BALANCE, { input: JSON.stringify(scenario), maxBuffer: 16 * 1024 * 1024 }).toString()) as {
    pairings: Array<{ a: string; b: string; aWinRate: number; draws: number }>;
  };
  const rate = (a: string, b: string) => out.pairings.find((p) => p.a === a && p.b === b)!.aWinRate;
  // Casting faster, drawing faster: each upgrade should win its own mirror.
  expect(rate('mage', 'quick')).toBeLessThan(0.5);
  expect(rate('healer', 'mender')).toBeLessThan(0.5);
  expect(rate('archer', 'rapid')).toBeLessThan(0.5);
});
