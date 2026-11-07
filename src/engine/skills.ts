// What a build's skills make of its attacks, spells and movement skills: the engine's fold
// (crates/engine/src/skills.rs resolve_skills, through crates/engine-wasm/src/skills.rs), asked when a
// build or its levels change, so the page keeps no copy of it. The skill book, the aim circles and
// the spells drawn online read it.
import type { Levels, ResolvedSkills, SkillSet } from '../content/skills';
import { answer, wasm, withText } from './wasm';

interface Calls {
  skills_resolve(p: number, n: number): number;
}

/** What a learned set does at these levels (one per skill-book entry; a missing one is level 1). */
export function resolveSkills(skills: SkillSet, levels: Levels = []): ResolvedSkills {
  const e = wasm() as unknown as Calls;
  const n = withText(JSON.stringify({ skills, levels }), (p, len) => e.skills_resolve(p, len));
  if (!n) throw new Error('the engine could not read that set of skills');
  const r = answer<Omit<ResolvedSkills, 'combos'> & { combos: string[] }>(n);
  return { ...r, combos: new Set(r.combos) };
}
