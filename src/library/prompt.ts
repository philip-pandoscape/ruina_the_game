import { boneChanges, directionWords, fmt3, r1 } from './pose';
import type { Note } from './store';
import type { Bone, Options, Phase, Subject, Take, Vec3 } from './types';

// The prompt the library writes for Claude from the open notes: what each animated thing is and
// where its animation is made, then every note with what the rules had the body doing on its frames
// and, for a corrected pose, exactly which bones turned how far and where that put the hands and
// feet, with a picture of it. It ends with how to check a change against the corrections.

export interface PromptContext {
  subject(id: string): Subject | undefined;
  /** A take of an animation (made if need be), for its bones and timeline. */
  take(subject: string, anim: string, options: Options): Take | null;
  image(name: string): { url: string; file: string | null };
  /** Where the notes are kept on disk (review.json), or null. */
  reviewFile: string | null;
  origin: string;
}

export const linkTo = (origin: string, subject: string, anim: string, options: Options, frame?: number): string => {
  const q = new URLSearchParams(options);
  if (frame !== undefined) q.set('f', String(frame));
  const s = q.toString();
  return `${origin}/dev/library.html#/${subject}/${anim}${s ? `?${s}` : ''}`;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (t: string) =>
  t.trim()
    ? t
        .trim()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    : '> (no words: the corrected pose says it)';

/** The skeleton as an indented list (fingers and carried things left out). */
function boneTree(bones: readonly Bone[]): string {
  const kids = new Map<string | null, Bone[]>();
  for (const b of bones) {
    if (b.minor || b.name.startsWith('@')) continue;
    const list = kids.get(b.parent) ?? [];
    list.push(b);
    kids.set(b.parent, list);
  }
  const names = new Set(bones.filter((b) => !b.minor && !b.name.startsWith('@')).map((b) => b.name));
  const roots = bones.filter((b) => !b.minor && !b.name.startsWith('@') && (!b.parent || !names.has(b.parent)));
  const out: string[] = [];
  const walk = (b: Bone, depth: number) => {
    out.push(`${'  '.repeat(depth)}- ${b.name}`);
    for (const k of kids.get(b.name) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  const extra = bones.filter((b) => b.minor || b.name.startsWith('@')).map((b) => b.name);
  return out.join('\n') + (extra.length ? `\n(also, not drawn in the skeleton: ${extra.join(', ')})` : '');
}

function phaseLine(phases: readonly Phase[]): string {
  return phases.map((p) => `${p.label} ${p.from}${p.to !== p.from ? `–${p.to}` : ''}`).join(' · ');
}

function phaseAt(phases: readonly Phase[], f: number): Phase | undefined {
  return phases.find((p) => f >= p.from && f <= p.to);
}

const v3 = (v: Vec3, digits = 3) => `(${v.map((n) => n.toFixed(digits)).join(', ')})`;

function describeFix(n: Note, ctx: PromptContext): string[] {
  const fix = n.fix!;
  const lines: string[] = [];
  const changes = boneChanges(fix.before, fix.after);
  if (changes.length) {
    lines.push('', "   Bones I changed (local transforms, in each bone's parent space; Euler XYZ in degrees):", '', '   | Bone | Before | After | Turned | About axis (parent space) | Moved |', '   |---|---|---|---|---|---|');
    for (const c of changes) {
      const touched = fix.touched.includes(c.bone) ? '' : ' (by IK)';
      lines.push(
        `   | ${c.bone}${touched} | ${fmt3(c.before)} | ${fmt3(c.after)} | ${r1(c.turned)}° | ${c.turned > 0.05 ? fmt3(c.axis, 2) : '–'} | ${c.moved ? `${fmt3(c.moved.map((m) => m * 100) as Vec3, 1)} cm` : '–'}${c.scaled ? `, scaled ${fmt3(c.scaled, 2)}` : ''} |`,
      );
    }
  }
  // Where the corrected pose put the joints that moved most (the body's own space).
  const moved = Object.keys(fix.model.after)
    .map((k) => {
      const a = fix.model.before[k];
      const b = fix.model.after[k];
      if (!a || !b) return null;
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      return { k, d, len: Math.hypot(...d), at: b };
    })
    .filter((x): x is { k: string; d: Vec3; len: number; at: Vec3 } => !!x && x.len > 0.01)
    .sort((x, y) => y.len - x.len);
  if (moved.length) {
    lines.push('', "   Where that puts the joints that moved most (the body's own space: x to its left, y up, z ahead; metres):", '');
    const shown = moved.filter((m) => !/^(palm|fingers|fingertips)/.test(m.k)).slice(0, 8);
    for (const m of shown) lines.push(`   - ${m.k}: ${directionWords(m.d)} (${(m.len * 100).toFixed(1)} cm in all), now at ${v3(m.at)}`);
  }
  if (fix.image) {
    const img = ctx.image(fix.image);
    lines.push('', img.file ? `   Picture (as it is | as I corrected it, from my view and from the side): \`${img.file}\`` : '   (No picture kept: the library ran without its dev server.)');
  }
  if (ctx.reviewFile) lines.push(`   The whole corrected pose (every joint's local transform) is in \`${ctx.reviewFile}\`, note id \`${n.id}\` → \`fix.after.joints\`.`);
  return lines;
}

/** The prompt for these notes (open ones, grouped by subject and animation). */
export function buildPrompt(notes: Note[], ctx: PromptContext): string {
  const open = notes.filter((n) => n.status === 'open');
  const bySubject = new Map<string, Note[]>();
  for (const n of open) {
    const list = bySubject.get(n.subject) ?? [];
    list.push(n);
    bySubject.set(n.subject, list);
  }
  const anims = new Set(open.map((n) => `${n.subject}|${n.anim}|${JSON.stringify(n.options)}`));
  const fixes = open.filter((n) => n.fix).length;
  const out: string[] = [];
  out.push(
    `# Animation review: ${plural(open.length, 'note')} on ${plural(anims.size, 'animation')}`,
    '',
    "I went through Ruina's animations in the animation library (`/dev/library.html`, src/library/) and left notes: on whole animations, on stretches of frames, and on single frames" +
      (fixes ? `, ${plural(fixes, 'of them', 'of them')} with the pose corrected by hand to show where the bones should have been` : '') +
      '. Please change the animation code so that each note below is dealt with.',
    '',
    '## How to work',
    '',
    '- Read each note with its frames: the timeline bands say what the rules have the body doing on them (a swing\'s wind-up, strike and recovery, the air, a landing). Frame numbers count from 0.',
    "- A corrected pose is the target for that frame. Change the code that makes the pose (not the bones of one frame) so the animation passes through it, and blend into and out of it so the frames around it stay smooth. Small differences that don't change how it reads are fine; the direction and size of the change matter.",
    "- Fix how it looks, not the rules' timing: frame counts (startup, active, recovery), speeds and the films in src/render/detail/scenarios.ts are game rules or stand for them; changing a rule means TypeScript and Rust together (AGENTS.md). If a note can only be met by changing timing, say so instead.",
    '- Keep src/sim/ untouched and the render code presentation only. Another session may be working on the animations: keep your changes to what the notes ask for.',
    `- The library reloads by itself when you save, and shows my corrected poses as green ghosts on their frames, so I can compare at once${ctx.origin ? ` (${ctx.origin}/dev/library.html)` : ''}.`,
    '',
  );

  for (const [sid, list] of bySubject) {
    const subject = ctx.subject(sid);
    const options = list[0].options;
    out.push(`## ${list[0].subjectName}${subject ? ` (\`${sid}\`)` : ''}`, '');
    if (subject) {
      const src = subject.source(options);
      out.push(src.system, '', 'Where it is made:', '');
      for (const f of src.files) out.push(`- \`${f.path}\`: ${f.what}`);
      if (src.conventions) out.push('', `Conventions: ${src.conventions}`);
    }
    // Its skeleton, from the first animation's take.
    const first = ctx.take(sid, list[0].anim, options);
    if (first) out.push('', '<details><summary>Its skeleton</summary>', '', boneTree(first.bones), '', '</details>');
    out.push('');

    // Animation by animation.
    const byAnim = new Map<string, Note[]>();
    for (const n of list) {
      const k = `${n.anim}|${JSON.stringify(n.options)}`;
      const l = byAnim.get(k) ?? [];
      l.push(n);
      byAnim.set(k, l);
    }
    for (const notes of byAnim.values()) {
      const n0 = notes[0];
      const take = ctx.take(sid, n0.anim, n0.options);
      const fps = take?.fps ?? n0.fps;
      const frames = take?.frames ?? n0.frames;
      const optWords = Object.entries(n0.options)
        .map(([k, v]) => {
          const o = subject?.options.find((x) => x.id === k);
          return o ? `${o.label} ${o.choices.find((c) => c.value === v)?.label ?? v}` : `${k} ${v}`;
        })
        .join(', ');
      out.push(`### ${n0.animLabel} (\`${n0.anim}\`)${optWords ? `, ${optWords}` : ''}`, '');
      out.push(`- ${frames} frames at ${fps} fps (${(frames / fps).toFixed(2)} s)${take?.loop ? ', looping' : ''}${frames !== n0.frames ? ` (it was ${n0.frames} frames when I noted it)` : ''}.`);
      if (subject) out.push(`- Made by: ${subject.animSource(n0.anim, n0.options)}.`);
      if (take?.phases.length) out.push(`- Timeline: ${phaseLine(take.phases)}.`);
      out.push(`- Look at it: ${linkTo(ctx.origin, sid, n0.anim, n0.options)}`, '');
      const ordered = [...notes].sort((a, b) => order(a) - order(b));
      ordered.forEach((n, i) => {
        const where =
          n.kind === 'anim' ? 'The whole animation' : n.kind === 'range' ? `Frames ${n.range![0]}–${n.range![1]}` : `Frame ${n.frame}`;
        const phase = take && n.kind !== 'anim' ? phaseAt(take.phases, n.kind === 'range' ? n.range![0] : n.frame!) : undefined;
        const phaseEnd = take && n.kind === 'range' ? phaseAt(take.phases, n.range![1]) : undefined;
        const phaseWords = phase ? ` (${phase.label}${phaseEnd && phaseEnd !== phase ? ` to ${phaseEnd.label}` : ''})` : '';
        const time = n.kind === 'frame' ? `, ${(n.frame! / fps).toFixed(2)} s` : n.kind === 'range' ? `, ${(n.range![0] / fps).toFixed(2)}–${((n.range![1] + 1) / fps).toFixed(2)} s` : '';
        out.push(`${i + 1}. **${where}**${phaseWords}${time}${n.fix ? ' — **pose correction**' : ''}`, '', quote(n.text).replace(/^/gm, '   '));
        if (n.state) {
          out.push('', `   On that frame: ${n.state.line}.`);
          if (n.state.detail && Object.keys(n.state.detail).length) out.push(`   What drives it: \`${JSON.stringify(n.state.detail)}\``);
        }
        if (n.fix) out.push(...describeFix(n, ctx));
        if (n.kind !== 'anim') out.push(`   Link: ${linkTo(ctx.origin, sid, n.anim, n.options, n.kind === 'range' ? n.range![0] : n.frame)}`);
        out.push('');
      });
    }
    if (subject) {
      const checks = subject.source(options).checks ?? [];
      if (checks.length) out.push('Checks for this one, which must still pass:', '', ...checks.map((c) => `- \`${c.command}\`: ${c.what}`), '');
    }
  }

  out.push('## Checking your change', '', '- `npm run typecheck`.');
  if (fixes && ctx.reviewFile)
    out.push(
      `- Measure the corrected poses against the code as it is now: \`REVIEW="${ctx.reviewFile}" npx playwright test tests/integration/library-review.spec.ts\`. For every pose correction it prints how far each bone I changed still is from my pose (degrees, in the body's space) and how far the joints I moved are from where I put them (cm), and writes a picture of the frame as it is now beside mine (\`images/<note id>-now.png\`). Aim for every corrected bone within a few degrees and every moved joint within 2-3 cm, unless a note says otherwise.`,
    );
  out.push(
    '- Run the checks listed under each animation above, and the suite for anything else you touched.',
    '- Then tell me, note by note, what you changed (file and function), and any note you could not meet and why. I will look at it in the library and mark the notes done.',
  );
  return out.join('\n');
}

function order(n: Note): number {
  return n.kind === 'anim' ? -1 : n.kind === 'range' ? n.range![0] : n.frame!;
}
