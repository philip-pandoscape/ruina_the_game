import { expect, test } from 'vitest';
import { creatureIds } from '../../src/render/creatures/closeUps';
import { RigBench } from '../../src/dev/library/bench/rigs';

// Close-up bodies. These are content (src/content/creatures), so what a test can check is that the
// content still describes a whole creature: every joint the poses turn is present, the hierarchy
// hangs together, and the weapons are where the hand is. Built and measured without drawing
// (src/dev/library/bench/rigs.ts); drawn, in the content library: tests/integration/creatures.spec.ts.

// Every channel src/render/character.ts turns. If a rig stops offering one, the poses would
// throw at runtime the first time that animation played; this catches it at build time instead.
const POSED = [
  'squash',
  'body',
  'hips',
  'torso',
  'neck',
  'head',
  'eyes',
  'cape',
  'capeTail',
  'legL',
  'kneeL',
  'footL',
  'legR',
  'kneeR',
  'footR',
  'shoulderL',
  'armL',
  'elbowL',
  'handL',
  'shoulderR',
  'armR',
  'elbowR',
  'handR',
];

test('every creature is registered and loads', () => {
  const ids = creatureIds();
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(new RigBench(id).info().id).toBe(id);
});

test('the hero has every joint its poses turn', () => {
  const hero = new RigBench('hero').info();
  for (const joint of POSED) expect(hero.joints).toContain(joint);
  // Two-bone limbs (hip, knee, ankle; shoulder, elbow, hand), a neck, blinking eyes and a cape
  // in two halves: 23 worn parts across 23 joints.
  expect(hero.parts).toBe(23);
  expect(hero.joints).toHaveLength(23);
});

test('the hero carries four weapons, one at a time', () => {
  const hero = new RigBench('hero').info();
  const weapons = hero.attachments.filter((a) => a.exclusive);
  expect(weapons.map((w) => w.name).sort()).toEqual(['bow', 'club', 'staff', 'sword']);
  // Three are swung in the right hand; the bow is held in the left.
  expect(
    weapons
      .filter((w) => w.joint === 'handR')
      .map((w) => w.name)
      .sort(),
  ).toEqual(['club', 'staff', 'sword']);
  expect(weapons.find((w) => w.name === 'bow')!.joint).toBe('handL');
  // The nocked arrow is shown alongside the bow, so it must not be exclusive.
  expect(hero.attachments.find((a) => a.name === 'arrow')!.exclusive).toBe(false);
});

test('the skeleton hangs together: turning the torso carries the head and the hands', () => {
  const rig = new RigBench('hero');
  const before = { head: rig.worldOf('head'), wrist: rig.worldOf('handR') };
  rig.pose('torso', 0, Math.PI / 2, 0);
  const after = { head: rig.worldOf('head'), wrist: rig.worldOf('handR') };

  // The head sits on the torso's own axis, so a yaw spins it without moving it.
  expect(Math.hypot(after.head[0] - before.head[0], after.head[2] - before.head[2])).toBeLessThan(0.01);
  // The hand is off to one side, so the same yaw swings it a long way round.
  expect(Math.hypot(after.wrist[0] - before.wrist[0], after.wrist[2] - before.wrist[2])).toBeGreaterThan(0.4);
  // And both stay at the height the torso put them.
  expect(Math.abs(after.head[1] - before.head[1])).toBeLessThan(0.01);
});

test('knees fold the shin back and elbows fold the forearm forward', () => {
  const rig = new RigBench('hero');
  const foot = rig.worldOf('footL');
  const hand = rig.worldOf('handR');
  rig.pose('kneeL', 1.2, 0, 0);
  rig.pose('elbowR', -1.2, 0, 0);
  const footBent = rig.worldOf('footL');
  const handBent = rig.worldOf('handR');
  // The ankle swings up and behind the knee; the hand comes up in front of the elbow.
  expect(footBent[2]).toBeLessThan(foot[2] - 0.15);
  expect(footBent[1]).toBeGreaterThan(foot[1] + 0.1);
  expect(handBent[2]).toBeGreaterThan(hand[2] + 0.15);
  expect(handBent[1]).toBeGreaterThan(hand[1] + 0.1);
  // And neither limb changes length: thigh 0.27 + shin 0.27, upper arm 0.22 + forearm 0.23.
  const hip = rig.worldOf('legL');
  const knee = rig.worldOf('kneeL');
  expect(Math.hypot(knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2])).toBeCloseTo(0.27, 3);
  expect(Math.hypot(footBent[0] - knee[0], footBent[1] - knee[1], footBent[2] - knee[2])).toBeCloseTo(0.27, 3);
});

test('the hero stands the right height', () => {
  const hero = new RigBench('hero').info();
  const rest = new Map(hero.rest.map(([name, x, y, z]) => [name, [x, y, z]]));
  // Feet near the ground, head near eye level: a race with the wrong scale shows up here.
  expect(rest.get('legL')![1]).toBeLessThan(0.7);
  // Ankles just above the floor, so a boot's sole rests on it.
  expect(rest.get('footL')![1]).toBeCloseTo(0.08, 3);
  expect(rest.get('head')![1]).toBeGreaterThan(1.2);
  expect(rest.get('head')![1]).toBeLessThan(1.6);
  // Shoulders are symmetric about the middle.
  expect(rest.get('shoulderL')![0]).toBeCloseTo(-rest.get('shoulderR')![0], 5);
});
