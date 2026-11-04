import { expect, test, type Page } from '@playwright/test';
import { creatureIds } from '../src/content/creatures/index';

// Close-up bodies. These are content now (src/content/creatures), so what a test can check is
// that the content still describes a whole creature: every joint the poses turn is present, the
// hierarchy hangs together, and the weapons are where the hand is.

const SHOTS = 'screenshots';

interface Loaded {
  id: string;
  joints: string[];
  parts: number;
  materials: string[];
  attachments: Array<{ name: string; joint: string; parts: number; exclusive: boolean }>;
  rest: Array<[string, number, number, number]>;
}

const open = async (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/creatures.html');
  await page.waitForFunction(() => typeof (window as any).__creatures === 'object');
  return errors;
};
const load = (page: Page, id: string) => page.evaluate((i) => (window as any).__creatures.load(i) as Loaded, id);
const worldOf = (page: Page, joint: string) => page.evaluate((j) => (window as any).__creatures.worldOf(j) as number[], joint);

// Every channel src/render/character.ts turns. If a rig stops offering one, the poses would
// throw at runtime the first time that animation played; this catches it at build time instead.
const POSED = [
  'squash', 'body', 'hips', 'torso', 'neck', 'head', 'eyes', 'cape', 'capeTail',
  'legL', 'kneeL', 'footL', 'legR', 'kneeR', 'footR',
  'shoulderL', 'armL', 'elbowL', 'handL', 'shoulderR', 'armR', 'elbowR', 'handR',
];

test('every creature is registered and loads', async ({ page }) => {
  const errors = await open(page);
  const ids = await page.evaluate(() => (window as any).__creatures.list() as string[]);
  expect(ids).toEqual(creatureIds());
  expect(ids.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the hero has every joint its poses turn', async ({ page }) => {
  await open(page);
  const hero = await load(page, 'hero');
  for (const joint of POSED) expect(hero.joints).toContain(joint);
  // Two-bone limbs (hip, knee, ankle; shoulder, elbow, hand), a neck, blinking eyes and a cape
  // in two halves: 23 worn parts across 23 joints.
  expect(hero.parts).toBe(23);
  expect(hero.joints).toHaveLength(23);
});

test('the hero carries four weapons, one at a time', async ({ page }) => {
  await open(page);
  const hero = await load(page, 'hero');
  const weapons = hero.attachments.filter((a) => a.exclusive);
  expect(weapons.map((w) => w.name).sort()).toEqual(['bow', 'club', 'staff', 'sword']);
  // Three are swung in the right hand; the bow is held in the left.
  expect(weapons.filter((w) => w.joint === 'handR').map((w) => w.name).sort()).toEqual(['club', 'staff', 'sword']);
  expect(weapons.find((w) => w.name === 'bow')!.joint).toBe('handL');
  // The nocked arrow is shown alongside the bow, so it must not be exclusive.
  expect(hero.attachments.find((a) => a.name === 'arrow')!.exclusive).toBe(false);
});

test('the skeleton hangs together: turning the torso carries the head and the hands', async ({ page }) => {
  await open(page);
  await load(page, 'hero');
  const before = { head: await worldOf(page, 'head'), wrist: await worldOf(page, 'handR') };
  await page.evaluate(() => (window as any).__creatures.pose('torso', 0, Math.PI / 2, 0));
  const after = { head: await worldOf(page, 'head'), wrist: await worldOf(page, 'handR') };

  // The head sits on the torso's own axis, so a yaw spins it without moving it.
  expect(Math.hypot(after.head[0] - before.head[0], after.head[2] - before.head[2])).toBeLessThan(0.01);
  // The hand is off to one side, so the same yaw swings it a long way round.
  expect(Math.hypot(after.wrist[0] - before.wrist[0], after.wrist[2] - before.wrist[2])).toBeGreaterThan(0.4);
  // And both stay at the height the torso put them.
  expect(Math.abs(after.head[1] - before.head[1])).toBeLessThan(0.01);
});

test('knees fold the shin back and elbows fold the forearm forward', async ({ page }) => {
  await open(page);
  await load(page, 'hero');
  const foot = await worldOf(page, 'footL');
  const hand = await worldOf(page, 'handR');
  await page.evaluate(() => (window as any).__creatures.pose('kneeL', 1.2, 0, 0));
  await page.evaluate(() => (window as any).__creatures.pose('elbowR', -1.2, 0, 0));
  const footBent = await worldOf(page, 'footL');
  const handBent = await worldOf(page, 'handR');
  // The ankle swings up and behind the knee; the hand comes up in front of the elbow.
  expect(footBent[2]).toBeLessThan(foot[2] - 0.15);
  expect(footBent[1]).toBeGreaterThan(foot[1] + 0.1);
  expect(handBent[2]).toBeGreaterThan(hand[2] + 0.15);
  expect(handBent[1]).toBeGreaterThan(hand[1] + 0.1);
  // And neither limb changes length: thigh 0.27 + shin 0.27, upper arm 0.22 + forearm 0.23.
  const hip = await worldOf(page, 'legL');
  const knee = await worldOf(page, 'kneeL');
  expect(Math.hypot(knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2])).toBeCloseTo(0.27, 3);
  expect(Math.hypot(footBent[0] - knee[0], footBent[1] - knee[1], footBent[2] - knee[2])).toBeCloseTo(0.27, 3);
});

test('the hero stands the right height', async ({ page }) => {
  await open(page);
  const hero = await load(page, 'hero');
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

test('looks right', async ({ page }) => {
  const errors = await open(page);
  for (const id of creatureIds()) {
    await load(page, id);
    for (const weapon of ['sword', 'bow']) {
      await page.evaluate((w) => (window as any).__creatures.show(w), weapon);
      await page.evaluate(() => (window as any).__creatures.frame());
      await page.screenshot({ path: `${SHOTS}/creature-${id}-${weapon}.png` });
    }
  }
  expect(errors).toEqual([]);
});
