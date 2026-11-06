import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { defaultBuild, parseBuild, readSavedBuild, savedBuild } from '../../src/content/build';
import { hasSkill, NODES, SKILL_POINTS, skillCount, skillsFrom } from '../../src/content/skills';
import { ABILITIES, emptyHotbar, emptyMovement, MOVEMENT_SKILLS, NO_ABILITY, NO_MOVEMENT, WEAPONS, type Build } from '../../src/content/tuning';

// A build kept in this browser (the training yard's and the battlefield's) names what it holds by id
// (src/content/build.ts savedBuild), as the server keeps a character's (crates/engine/src/skills.rs),
// so it means the same whatever order the content comes in; a build kept by index before that still
// loads, read in the order it was kept in (shared/buildsByIndex.json).

const weapon = (id: string) => WEAPONS.findIndex((w) => w.name === id);
const ability = (id: string) => ABILITIES.findIndex((a) => a.id === id);
const move = (id: string) => MOVEMENT_SKILLS.findIndex((m) => m.id === id);

/** Club Training and Healing Circle, with the circle in the third slot and Block on E. */
function healer(): Build {
  const b: Build = { skills: skillsFrom('club', 'heal', 'block'), weapon: weapon('club'), abilities: emptyHotbar(), movement: emptyMovement() };
  b.abilities[2] = ability('heal');
  b.movement[1] = move('block');
  return b;
}

test('a build is kept by id', () => {
  expect(savedBuild(healer())).toEqual({
    weapon: 'club',
    skills: ['club', 'heal', 'block'],
    abilities: [null, null, 'heal', null, null, null, null, null],
    movement: [null, 'block'],
  });
  // As the server keeps one: the same text.
  const kept = JSON.parse(JSON.stringify(savedBuild(healer())));
  expect(readSavedBuild(kept)).toEqual(healer());
  for (const b of [defaultBuild(), healer()]) expect(readSavedBuild(JSON.parse(JSON.stringify(savedBuild(b))))).toEqual(b);
});

test('a kept build is read into the content as it is now', () => {
  const b = readSavedBuild({ weapon: 'bow', skills: ['backstep', 'bow'], abilities: [], movement: ['backstep'] });
  expect(b).toEqual({ skills: skillsFrom('bow', 'backstep'), weapon: weapon('bow'), abilities: emptyHotbar(), movement: [move('backstep'), NO_MOVEMENT] });
  // What the content no longer has is left out, and what's left kept as far as it still hangs together.
  const gone = readSavedBuild({ weapon: 'sword', skills: ['sword', 'cleave', 'longGone'], abilities: ['oldSpell'], movement: [null, 'teleport'] });
  expect(gone).toEqual({ skills: skillsFrom('sword', 'cleave'), weapon: weapon('sword'), abilities: emptyHotbar(), movement: emptyMovement() });
  const cut = readSavedBuild({ weapon: 'sword', skills: ['sword', 'whirlwind'], abilities: [], movement: [] });
  expect(cut?.skills).toEqual(skillsFrom('sword'));
  // Not a build, or more than the points allow.
  expect(readSavedBuild(null)).toBeNull();
  expect(readSavedBuild('sword')).toBeNull();
  expect(readSavedBuild({ weapon: true, skills: [] })).toBeNull();
  expect(readSavedBuild({ weapon: 'sword', skills: [] })).toBeNull();
  expect(readSavedBuild({ weapon: 'club', skills: ['club', 'heal', 'swiftMending'] }, 2)).toBeNull();
});

// Builds as the browser kept them before they named things by id (c3d19c3's src/app/savedBuild.ts,
// its localStorage text as it wrote it), with what each holds.
const KEPT_BY_INDEX: Array<[string, { weapon: string; skills: string[]; abilities: Record<number, string>; movement: Record<number, string> }]> = [
  [
    '{"skills":[1,0,0,0,0,0,0,0],"weapon":0,"abilities":[255,255,255,255,255,255,255,255],"movement":[255,255]}',
    { weapon: 'sword', skills: ['sword'], abilities: {}, movement: {} },
  ],
  [
    '{"skills":[4097,0,0,0,0,0,0,0],"weapon":0,"abilities":[255,255,255,255,255,255,255,255],"movement":[255,0]}',
    { weapon: 'sword', skills: ['sword', 'dodgeRoll'], abilities: {}, movement: { 1: 'dodgeRoll' } },
  ],
  [
    '{"skills":[24,0,0,0,0,0,0,0],"weapon":1,"abilities":[255,255,0,255,255,255,255,255],"movement":[255,255]}',
    { weapon: 'club', skills: ['club', 'heal'], abilities: { 2: 'heal' }, movement: {} },
  ],
  [
    '{"skills":[192,0,0,0,0,0,0,0],"weapon":2,"abilities":[1,255,255,255,255,255,255,255],"movement":[255,255]}',
    { weapon: 'staff', skills: ['staff', 'meteor'], abilities: { 0: 'meteor' }, movement: {} },
  ],
  [
    '{"skills":[8704,0,0,0,0,0,0,0],"weapon":3,"abilities":[255,255,255,255,255,255,255,255],"movement":[1,255]}',
    { weapon: 'bow', skills: ['bow', 'backstep'], abilities: {}, movement: { 0: 'backstep' } },
  ],
  [
    '{"skills":[32767,0,0,0,0,0,0,0],"weapon":3,"abilities":[255,255,255,255,1,255,255,0],"movement":[2,0]}',
    {
      weapon: 'bow',
      skills: [
        'sword',
        'cleave',
        'whirlwind',
        'club',
        'heal',
        'swiftMending',
        'staff',
        'meteor',
        'quickIncantation',
        'bow',
        'rapidFire',
        'piercing',
        'dodgeRoll',
        'backstep',
        'block',
      ],
      abilities: { 4: 'meteor', 7: 'heal' },
      movement: { 0: 'block', 1: 'dodgeRoll' },
    },
  ],
];

test('a build kept by index is read in the order it was kept in', () => {
  for (const [text, want] of KEPT_BY_INDEX) {
    const b = readSavedBuild(JSON.parse(text));
    expect(b, text).not.toBeNull();
    expect(
      NODES.filter((_, i) => hasSkill(b!.skills, i))
        .map((n) => n.id)
        .sort(),
      text,
    ).toEqual([...want.skills].sort());
    expect(WEAPONS[b!.weapon].name, text).toBe(want.weapon);
    expect(b!.abilities, text).toEqual(emptyHotbar().map((_, i) => (want.abilities[i] ? ability(want.abilities[i]) : NO_ABILITY)));
    expect(b!.movement, text).toEqual(emptyMovement().map((_, i) => (want.movement[i] ? move(want.movement[i]) : NO_MOVEMENT)));
    // And it's kept by id from then on.
    expect(readSavedBuild(JSON.parse(JSON.stringify(savedBuild(b!))))).toEqual(b);
  }
  // Thirty nodes across the tree, as the old order had them.
  const grown = readSavedBuild(
    JSON.parse('{"skills":[101060615,1065354224,66584576,1572864,0,0,0,0],"weapon":0,"abilities":[255,255,255,255,255,255,255,255],"movement":[0,255]}'),
  );
  expect(grown && skillCount(grown.skills)).toBe(30);
  expect(readSavedBuild(JSON.parse('{"skills":[101060615,1065354224,66584576,1572864,0,0,0,0],"weapon":0}'), 29)).toBeNull();
});

test('builds kept before the tree was a graph still load', () => {
  // The learned set as one number (Sword and Club Training), and the hotbar as two named slots.
  const old = readSavedBuild({ perks: 9, weapon: 1, ability1: NO_ABILITY, ability2: NO_ABILITY });
  expect(old).toEqual({ skills: skillsFrom('sword', 'club'), weapon: weapon('club'), abilities: emptyHotbar(), movement: emptyMovement() });
  const caster = readSavedBuild({ skills: 24, weapon: 1, ability1: 0 });
  expect(caster?.abilities[0]).toBe(ability('heal'));
  // Something the old order hasn't got is left out.
  expect(readSavedBuild({ skills: [1, 0, 0, 0, 0, 0, 0, 1 << 31], weapon: 0, abilities: [77], movement: [9] })).toEqual(defaultBuild());
  expect(readSavedBuild({ skills: [1], weapon: 9 })).toEqual(defaultBuild());
});

test('the order builds were kept in never changes', () => {
  // Frozen: a build kept by index means these, whatever the content's order is now.
  const order = JSON.parse(readFileSync('shared/buildsByIndex.json', 'utf8'));
  expect([order.weapons, order.abilities, order.movementSkills]).toEqual([
    ['sword', 'club', 'staff', 'bow'],
    ['heal', 'meteor'],
    ['dodgeRoll', 'backstep', 'block', 'slide'],
  ]);
  expect(order.skillNodes).toHaveLength(226);
  expect(new Set(order.skillNodes).size).toBe(226);
});

test('a build on the wire is read by its places in the content', () => {
  const b = healer();
  expect(parseBuild(JSON.parse(JSON.stringify(b)))).toEqual(b);
  expect(parseBuild({ skills: b.skills, weapon: b.weapon })).toEqual({ ...b, abilities: emptyHotbar(), movement: emptyMovement() });
  expect(parseBuild(savedBuild(b))).toBeNull();
  expect(parseBuild({ ...b, skills: skillsFrom('club', 'heal', 'swiftMending', 'block') }, 3)).toBeNull();
  expect(parseBuild({ ...b, weapon: weapon('bow') }), 'a weapon not learned').toBeNull();
  expect(parseBuild(b, SKILL_POINTS)).toEqual(b);
});
