import { test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The animation library's pose corrections, held against the code as it is now. Point REVIEW at a
// review.json the library kept (reviews/animations/review.json): every open note with a corrected
// pose is opened on its frame, measured (how far each bone the user changed still is from their pose,
// in the body's own space, and how far the joints they moved are from where they put them) and drawn
// with the correction's ghost over it, saved as images/<note id>-now.png beside the user's picture.
// The results are printed and kept in check.md next to review.json. Without REVIEW it is skipped.
//
//   REVIEW="C:\...\reviews\animations\review.json" npx playwright test tests/library-review.spec.ts

interface Measure {
  bones: Array<{ name: string; now: number; was: number }>;
  joints: Array<{ name: string; now: number; was: number }>;
  worstDeg: number;
  worstM: number;
  wasDeg: number;
  wasM: number;
  progress: number;
}
interface Note {
  id: string;
  subject: string;
  subjectName: string;
  anim: string;
  animLabel: string;
  frame?: number;
  text: string;
  status: string;
  fix?: unknown;
}

const REVIEW = process.env.REVIEW;

test('pose corrections against the code as it is now', async ({ page }) => {
  test.skip(!REVIEW, 'set REVIEW to a review.json kept by the animation library');
  test.setTimeout(600_000);
  const review = JSON.parse(readFileSync(REVIEW!, 'utf8')) as { notes: Note[] };
  const notes = review.notes.filter((n) => n.status === 'open' && n.fix);
  const dir = dirname(REVIEW!);
  mkdirSync(join(dir, 'images'), { recursive: true });
  await page.goto('/library.html?test');
  await page.waitForFunction(() => (window as unknown as { __library?: { ready: boolean } }).__library?.ready, null, { timeout: 120_000 });

  const out: string[] = [`# Pose corrections against the code (${new Date().toLocaleString()})`, ''];
  let matched = 0;
  for (const n of notes) {
    const r = (await page.evaluate((note) => (window as unknown as { __library: { check(n: unknown): Promise<unknown> } }).__library.check(note), n)) as { measure: Measure | null; image: string; frames: number };
    const file = join(dir, 'images', `${n.id}-now.png`);
    writeFileSync(file, Buffer.from(r.image.split(',')[1], 'base64'));
    const head = `- ${n.subjectName} · ${n.animLabel} · frame ${n.frame}: “${n.text || 'a corrected pose'}” (note ${n.id})`;
    const m = r.measure;
    if (!m) {
      out.push(head, `  The animation is ${r.frames} frames long now: frame ${n.frame} is gone. Picture: ${file}`, '');
      continue;
    }
    const ok = m.worstDeg < 4 && m.worstM < 0.025;
    if (ok) matched++;
    out.push(
      head,
      `  ${ok ? 'MATCHES' : 'NOT YET'}: worst bone ${m.worstDeg.toFixed(1)}° from the corrected pose (was ${m.wasDeg.toFixed(1)}°), worst joint ${(m.worstM * 100).toFixed(1)} cm (was ${(m.wasM * 100).toFixed(1)} cm); ${Math.round(m.progress * 100)}% of the way.`,
      `  Bones: ${m.bones.map((b) => `${b.name} ${b.now.toFixed(1)}° (was ${b.was.toFixed(1)}°)`).join(' · ') || '–'}`,
      `  Joints: ${
        m.joints
          .sort((a, b) => b.was - a.was)
          .slice(0, 8)
          .map((j) => `${j.name} ${(j.now * 100).toFixed(1)} cm (was ${(j.was * 100).toFixed(1)} cm)`)
          .join(' · ') || '–'
      }`,
      `  Picture now (the corrected pose as a green ghost over the frame): ${file}`,
      '',
    );
  }
  out.push(`${matched} of ${notes.length} pose corrections matched (within 4° and 2.5 cm).`);
  const text = out.join('\n');
  writeFileSync(join(dir, 'check.md'), text);
  console.log(`\n${text}\n`);
});
