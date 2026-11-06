import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  applyChannel,
  applyFrames,
  bookIndex,
  dependents,
  emptySkills,
  gather,
  hasSkill,
  LEVEL_MODS,
  LEVEL_XP,
  levelOf,
  levelsFrom,
  LINKS,
  MAX_LEVEL,
  MAX_NODES,
  NODES,
  pathTo,
  reachable,
  resolveSkills,
  ROOTS,
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
import { learnBlock, learnPath, NODE_INFO, validBuild } from '../src/build';
import { castFramesFor, comboFor, emptyHotbar, emptyMovement, meleeTargets, movementCooldownFor, movementStaminaFor, MOVEMENT_SKILLS, pierceTargets, WEAPONS, type Build } from '../src/tuning';

// Its tests share nothing, so they spread across the workers (playwright.config.ts).
test.describe.configure({ mode: 'parallel' });

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

const cost = (from: string[], to: string) => pathTo(skillsFrom(...from), skillIndex(to)).map((i) => NODES[i].id);

test('every link joins two nodes that exist, and everything can be reached from a root', () => {
  const ids = new Set(NODES.map((n) => n.id));
  expect(ids.size).toBe(NODES.length);
  for (const l of LINKS) expect(l.a !== l.b && NODES[l.a] && NODES[l.b]).toBeTruthy();
  // Learn outward from every root at once: the whole tree is one piece.
  let s = emptySkills();
  for (const r of ROOTS) s = withSkill(s, r, true);
  for (let grew = true; grew; ) {
    grew = false;
    NODES.forEach((_, i) => {
      if (!hasSkill(s, i) && reachable(s, i)) {
        s = withSkill(s, i, true);
        grew = true;
      }
    });
  }
  expect(skillCount(s)).toBe(NODES.length);
  expect(soundTree(s)).toBe(true);
});

test('the fifteen skills keep their old places, so saved builds still mean the same', () => {
  const OLD = ['sword', 'cleave', 'whirlwind', 'club', 'heal', 'swiftMending', 'staff', 'meteor', 'quickIncantation', 'bow', 'rapidFire', 'piercing', 'dodgeRoll', 'backstep', 'block'];
  expect(NODES.slice(0, 15).map((n) => n.id)).toEqual(OLD);
  expect(ROOTS.map((i) => NODES[i].id).sort()).toEqual(['bow', 'club', 'staff', 'sword']);
});

test('a node is open when it is a root or touches something learned', () => {
  expect(reachable(emptySkills(), skillIndex('club'))).toBe(true);
  expect(reachable(emptySkills(), skillIndex('cleave'))).toBe(false);
  expect(reachable(skillsFrom('sword'), skillIndex('cleave'))).toBe(true);
  expect(reachable(skillsFrom('sword'), skillIndex('whirlwind'))).toBe(false);
});

test('each skill costs what it did before the tree grew', () => {
  expect(cost([], 'sword')).toEqual(['sword']);
  expect(cost([], 'whirlwind')).toEqual(['sword', 'cleave', 'whirlwind']);
  expect(cost(['sword'], 'dodgeRoll')).toEqual(['dodgeRoll']);
  expect(cost(['sword'], 'heal')).toEqual(['club', 'heal']);
  expect(cost(['bow', 'rapidFire'], 'piercing')).toEqual(['piercing']);
  expect(cost(['sword'], 'sword')).toEqual([]);
});

test('unlearning takes everything that would be cut off, and nothing else', () => {
  const s = skillsFrom('sword', 'cleave', 'whirlwind', 'club', 'heal');
  expect(dependents(s, skillIndex('cleave')).map((i) => NODES[i].id).sort()).toEqual(['cleave', 'whirlwind']);
  expect(dependents(s, skillIndex('club')).map((i) => NODES[i].id).sort()).toEqual(['club', 'heal']);
  expect(dependents(s, skillIndex('whirlwind')).map((i) => NODES[i].id)).toEqual(['whirlwind']);
});

test('a set that does not hang together back to a root is not sound', () => {
  expect(soundTree(skillsFrom('sword', 'cleave'))).toBe(true);
  expect(soundTree(withSkill(emptySkills(), skillIndex('cleave'), true))).toBe(false); // cleave without sword
  expect(soundTree(withSkill(skillsFrom('sword'), NODES.length, true))).toBe(false); // past the end of the tree
});

test('builds are checked against the points allowed where you are', () => {
  const b: Build = { skills: skillsFrom('sword', 'cleave', 'whirlwind'), weapon: 0, abilities: emptyHotbar(), movement: emptyMovement() };
  expect(validBuild(b)).toBe(true); // the training yard's budget
  expect(validBuild(b, 3)).toBe(true);
  expect(validBuild(b, 2)).toBe(false);
  expect(learnBlock(b, NODE_INFO[skillIndex('dodgeRoll')], 3)).toBe('No skill points left');
  expect(learnBlock(b, NODE_INFO[skillIndex('heal')], 10)).toBe('Learn Club Training first');
  expect(learnPath(b, pathTo(b.skills, skillIndex('heal')), 5)?.skills).toEqual(skillsFrom('sword', 'cleave', 'whirlwind', 'club', 'heal'));
  expect(learnPath(b, pathTo(b.skills, skillIndex('heal')), 4)).toBeNull();
});

// ---------- Levels ----------

test('levels follow the experience curve and stop at the top', () => {
  expect(levelOf(0)).toBe(1);
  expect(levelOf(LEVEL_XP[1] - 1)).toBe(1);
  expect(levelOf(LEVEL_XP[1])).toBe(2);
  expect(levelOf(LEVEL_XP[MAX_LEVEL - 1])).toBe(MAX_LEVEL);
  expect(levelOf(LEVEL_XP[MAX_LEVEL - 1] * 10)).toBe(MAX_LEVEL);
  const lv = levelsFrom({ sword: LEVEL_XP[3], heal: LEVEL_XP[1] });
  expect(lv[bookIndex('sword')]).toBe(4);
  expect(lv[bookIndex('heal')]).toBe(2);
  expect(lv[bookIndex('meteor')]).toBe(1);
});

test('a level adds to its own skill only', () => {
  const s = skillsFrom('sword', 'club', 'heal');
  const lv = levelsFrom({ sword: LEVEL_XP[2] }); // sword level 3
  const plain = resolveSkills(s);
  const trained = resolveSkills(s, lv);
  const per = LEVEL_MODS.sword[0].value;
  expect(comboFor(0, trained)[0].damage).toBeCloseTo(comboFor(0, plain)[0].damage * (1 + 2 * per), 6);
  expect(comboFor(1, trained)[0].damage).toBe(comboFor(1, plain)[0].damage); // the club is untouched
  expect(trained.ability).toEqual(plain.ability);
});

test('a dodge costs less stamina through the tree and with its level, and has no cooldown', () => {
  const dodge = MOVEMENT_SKILLS.findIndex((m) => m.id === 'dodgeRoll');
  const base = MOVEMENT_SKILLS[dodge].staminaCost ?? 0;
  expect(base).toBeGreaterThan(0);
  const plain = resolveSkills(skillsFrom('sword', 'dodgeRoll'));
  expect(movementStaminaFor(dodge, plain)).toBe(base);
  expect(movementCooldownFor(dodge, plain)).toBe(0);
  const levelled = resolveSkills(skillsFrom('sword', 'dodgeRoll'), levelsFrom({ dodgeRoll: LEVEL_XP[4] })); // level 5
  expect(LEVEL_MODS.dodgeRoll[0].stat).toBe('movement.stamina');
  expect(movementStaminaFor(dodge, levelled)).toBeCloseTo(base * (1 + 4 * LEVEL_MODS.dodgeRoll[0].value), 9);
  // A Footwork passive in the tree, wherever it is, makes it cheaper too.
  const footwork = NODES.findIndex((n) => n.mods?.some((m) => m.stat === 'movement.stamina' && m.skill === 'dodgeRoll'));
  const path = pathTo(skillsFrom('sword', 'dodgeRoll'), footwork);
  let s = skillsFrom('sword', 'dodgeRoll');
  for (const i of path) s = withSkill(s, i, true);
  expect(movementStaminaFor(dodge, resolveSkills(s))).toBeLessThan(base);
  // The guard keeps its cooldown, and the tree still shortens that.
  const block = MOVEMENT_SKILLS.findIndex((m) => m.id === 'block');
  expect(movementCooldownFor(block, resolveSkills(skillsFrom('club', 'block')))).toBe(MOVEMENT_SKILLS[block].cooldownFrames);
  expect(movementStaminaFor(block, resolveSkills(skillsFrom('club', 'block')))).toBe(0);
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
