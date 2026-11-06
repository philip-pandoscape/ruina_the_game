import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The content library (/dev/library.html, src/dev/library/): every character's animations open and play,
// a corrected pose becomes a note with a picture and the bones it moved, notes outlive a reload (kept
// by the dev server), and the prompt carries what Claude needs. Notes made here go to
// test-results/anim-reviews/ (?test), never to reviews/.

type Lib = {
  ready: boolean;
  subjects(): Array<{ id: string; name: string; group: string; anims: Array<{ id: string; frames: number }> }>;
  open(s: string, a: string, o?: Record<string, string>, f?: number): Promise<void>;
  state(): { subject: string; anim: string; frame: number; frames: number; baked: number; editing: boolean; touched: string[] };
  seek(f: number): void;
  pause(): void;
  bakeAll(): void;
  bones(): string[];
  turn(bone: string, axis: 'x' | 'y' | 'z', deg: number): void;
  keepCorrection(text: string): Promise<string | null>;
  note(kind: 'anim' | 'range' | 'frame', text: string, range?: [number, number]): Promise<string | null>;
  notes(): Array<{ id: string; kind: string; frame?: number; range?: [number, number]; text: string; fix?: { touched: string[]; image?: string } }>;
  prompt(scope?: 'anim' | 'subject' | 'all'): Promise<string>;
  check(n: unknown): Promise<{ measure: { worstDeg: number; wasDeg: number; progress: number } | null; image: string; frames: number }>;
  flush(): Promise<void>;
};

const DIR = join(process.cwd(), 'test-results', 'anim-reviews');

async function load(page: Page, hash = ''): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/dev/library.html?test${hash}`);
  await page.waitForFunction(() => (window as unknown as { __library?: Lib }).__library?.ready, null, { timeout: 90_000 });
  expect(errors).toEqual([]);
}

const lib = (page: Page) => page.evaluateHandle(() => (window as unknown as { __library: Lib }).__library);

test.beforeAll(() => rmSync(DIR, { recursive: true, force: true }));

test('every character lists its animations, and each opens and plays', async ({ page }) => {
  test.setTimeout(240_000);
  await load(page);
  const subjects = await page.evaluate(() => (window as unknown as { __library: Lib }).__library.subjects());
  const ids = subjects.map((s) => s.id);
  for (const want of ['hero', 'slime', 'crowd-fighter', 'chicken', 'cow', 'villager-hollis', 'mount-horse']) expect(ids).toContain(want);
  for (const s of subjects) expect(s.anims.length, s.id).toBeGreaterThan(0);
  // One animation of each kind of subject, worked out to its end without an error.
  const results = await page.evaluate(async () => {
    const L = (window as unknown as { __library: Lib }).__library;
    const out: Array<{ id: string; frames: number; baked: number; bones: number }> = [];
    for (const [s, a] of [
      ['hero', 'sword'],
      ['slime', 'leap'],
      ['crowd-hero', 'run'],
      ['crowd-fighter', 'attack'],
      ['sheep', 'hungry'],
      ['villager-mara', 'talk'],
      ['mount-donkey', 'run'],
    ]) {
      await L.open(s, a);
      L.bakeAll();
      L.seek(5);
      const st = L.state();
      out.push({ id: `${s}/${a}`, frames: st.frames, baked: st.baked, bones: L.bones().length });
    }
    return out;
  });
  for (const r of results) {
    expect(r.baked, r.id).toBe(r.frames);
    expect(r.bones, r.id).toBeGreaterThan(1);
  }
  // The address says what's open, so a reload (after a code change) comes back to it.
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('#/mount-donkey/run');
});

test('a corrected pose becomes a note with a picture, survives a reload, and goes into the prompt', async ({ page }) => {
  test.setTimeout(240_000);
  await load(page, '#/hero/sword?weapon=0&f=36');
  const L = await lib(page);
  const id = await page.evaluate(async (L) => {
    L.pause();
    L.bakeAll();
    L.seek(36);
    await new Promise((r) => setTimeout(r, 200));
    L.turn('armR', 'x', -30);
    return L.keepCorrection('The sword arm should be higher here');
  }, L);
  expect(id).toBeTruthy();
  const notes = await page.evaluate((L) => L.notes(), L);
  const fix = notes.find((n) => n.id === id)!;
  expect(fix.kind).toBe('frame');
  expect(fix.frame).toBe(36);
  expect(fix.fix?.touched).toContain('armR');
  expect(fix.fix?.image).toBe(`${id}.png`);
  await page.evaluate(async (L) => {
    await L.note('range', 'The strike is too slow', [40, 46]);
    await L.note('anim', 'More hip turn into every swing');
    await L.flush();
  }, L);

  // Kept on disk by the dev server, picture and all.
  const saved = JSON.parse(readFileSync(join(DIR, 'review.json'), 'utf8')) as { notes: unknown[] };
  expect(saved.notes).toHaveLength(3);
  expect(existsSync(join(DIR, 'images', `${id}.png`))).toBe(true);

  // The code hasn't changed: the animation is as far from the correction as it was.
  const check = await page.evaluate((L) => L.check(L.notes().find((n) => n.fix)), L);
  expect(check.measure).not.toBeNull();
  expect(check.measure!.worstDeg).toBeGreaterThan(20);
  expect(check.measure!.progress).toBeLessThan(0.1);
  expect(check.image.startsWith('data:image/png')).toBe(true);

  // After a reload the notes come back from the dev server.
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __library?: Lib }).__library?.ready, null, { timeout: 90_000 });
  const back = await page.evaluate(() => (window as unknown as { __library: Lib }).__library.notes().length);
  expect(back).toBe(3);
  expect(await page.evaluate(() => (window as unknown as { __library: Lib }).__library.state().anim)).toBe('sword');

  // The prompt: where the hero's animation is made, each note, the bones the correction turned.
  const prompt = await page.evaluate(() => (window as unknown as { __library: Lib }).__library.prompt('all'));
  expect(prompt).toContain('# Animation review: 3 notes on 1 animation');
  expect(prompt).toContain('src/render/detail/humanoid.ts');
  expect(prompt).toContain('**Frame 36**');
  expect(prompt).toContain('pose correction');
  expect(prompt).toMatch(/\| armR \| [-\d.]+, [-\d.]+, [-\d.]+ \| [-\d.]+, [-\d.]+, [-\d.]+ \| 30(\.\d)?° \|/);
  expect(prompt).toContain('**Frames 40–46**');
  expect(prompt).toContain('**The whole animation**');
  expect(prompt).toContain(`${id}.png`);
  expect(prompt).toContain('tests/integration/library-review.spec.ts');
});

test('the library is laid out and answers the keyboard', async ({ page }) => {
  test.setTimeout(120_000);
  await load(page, '#/hero/run');
  // Pick a character from the list, then one of its animations.
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  await page.locator('.subject', { hasText: 'Slime' }).click();
  await expect(page.locator('.anim.on')).toContainText('Idle');
  await page.locator('.anim', { hasText: 'Hop' }).click();
  await expect(page.locator('.crumbs')).toContainText('Hop');
  // Space plays and pauses; arrows step a frame. Opened from a link, the library starts paused, so
  // the first Space plays: the frame must be read only after the second has paused it again, or a
  // page drawing slowly (in software, as CI's does) moves on between the reading and the steps.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const frame = () => page.evaluate(() => (window as unknown as { __library: Lib }).__library.state().frame);
  const still = await frame();
  await page.keyboard.press('Space');
  await expect.poll(frame).not.toBe(still);
  await page.keyboard.press('Space');
  const f0 = await frame();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(frame).toBe((f0 + 2) % 36);
  // P starts correcting the frame; Escape throws it away.
  await page.keyboard.press('p');
  await expect(page.locator('.banner')).toContainText('Correcting frame');
  await page.keyboard.press('Escape');
  await expect(page.locator('.banner')).toBeHidden();
  // Create Prompt opens with whatever is open.
  await page.getByRole('button', { name: 'Create Prompt' }).click();
  await expect(page.locator('.modal')).toContainText('Create Prompt');
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);
});

test("the hero's films: outdoors as their page drew them, laid out as a contact sheet, and measured on the made body", async ({ page }) => {
  test.setTimeout(120_000);
  await load(page, '#/hero/sword?weapon=0');
  const L = await lib(page);
  // Every film in src/render/detail/scenarios.ts, as the measurements list them.
  const films = await page.evaluate((L) => {
    const lib = L as unknown as { subjects(): Array<{ id: string; anims: Array<{ id: string }> }>; measure: { list(): Array<{ id: string }> } };
    return {
      listed: lib
        .subjects()
        .find((s) => s.id === 'hero')!
        .anims.map((a) => a.id),
      measured: lib.measure.list().map((f) => f.id),
    };
  }, L);
  expect(films.listed).toEqual(films.measured);
  // Outdoors, on grass under the sky; and back in the studio.
  const backdrop = () => page.evaluate(() => (window as unknown as { __library: { app: { stage: { backdrop: string } } } }).__library.app.stage.backdrop);
  await page.keyboard.press('b');
  await expect.poll(backdrop).toBe('outdoors');
  await page.locator('.viewport').screenshot({ path: 'screenshots/library-hero-outdoors.png' });
  await page.keyboard.press('b');
  await expect.poll(backdrop).toBe('studio');
  // Six frames of the swing side by side, until anything else is asked.
  const sheet = await page.evaluate(() => {
    const lib = (window as unknown as { __library: { sheet(o: { count: number }): number[]; app: { sheet: { active: boolean } } } }).__library;
    return { frames: lib.sheet({ count: 6 }), active: lib.app.sheet.active };
  });
  expect(sheet.frames).toHaveLength(6);
  expect(sheet.active).toBe(true);
  await page.locator('.viewport').screenshot({ path: 'screenshots/library-hero-sheet.png' });
  await page.evaluate((L) => L.seek(3), L);
  expect(await page.evaluate(() => (window as unknown as { __library: { app: { sheet: { active: boolean } } } }).__library.app.sheet.active)).toBe(false);
  // The measurements the unit tier runs on the box hero, here on the body the hero wears.
  const run = await page.evaluate(() =>
    (window as unknown as { __library: { measure: { joints(id: string, f: number): { joints: Record<string, number[]> } } } }).__library.measure.joints(
      'run',
      10,
    ),
  );
  expect(run.joints.head.every(Number.isFinite)).toBe(true);
  expect(run.joints.head[1]).toBeGreaterThan(1.2);
});
