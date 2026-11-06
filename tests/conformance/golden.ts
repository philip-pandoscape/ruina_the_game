import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll } from 'vitest';

// The engine's own guard for when this tier goes (the refactor's Phase 8 deletes the TypeScript
// rules, and with them these comparisons): every scenario a check program runs here, with a hash of
// what it printed, is kept in crates/engine/tests/golden/, and the engine's golden tests
// (crates/engine/src/checks/mod.rs) run the same scenarios through the rules and hold them to those
// hashes bit for bit. A case is kept only once the TypeScript has agreed with it, so the hashes are
// of answers this tier proved right.
//
// Written only when asked, after a change these tests have just passed on (a rule changed on both
// sides, the island rebaked):  RUINA_GOLDEN=1 npm run test:conformance

const DIR = 'crates/engine/tests/golden';

/** FNV-1a, 64 bits, over the text's UTF-8 bytes, as 16 hex digits: the golden tests hash the same way. */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(text, 'utf8')) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

/** A step of input in the fixtures: these, in this order (crates/engine/src/checks/mod.rs reads them back). */
const STEP = ['moveX', 'moveZ', 'buttons', 'abilitySlot', 'movementSlot', 'movementHeld', 'aimX', 'aimZ', 'faceX', 'faceZ', 'stickX', 'stickY'] as const;
/** The buttons, a bit each. */
const BUTTONS = ['jumpPressed', 'jumpHeld', 'attackPressed', 'slidePressed', 'sprintHeld', 'crouchHeld'] as const;
const KNOWN = new Set<string>([...STEP, ...BUTTONS]);

/** A script's steps as runs of the same step, each step a row of numbers: a long script is mostly runs. */
function compact(steps: Array<Record<string, number | boolean>>): Array<[number, number[]]> {
  const runs: Array<[number, number[]]> = [];
  let last = '';
  for (const s of steps) {
    const odd = Object.keys(s).find((k) => !KNOWN.has(k));
    if (odd) throw new Error(`a step's ${odd} has no place in the golden fixtures (tests/conformance/golden.ts STEP)`);
    const buttons = BUTTONS.reduce((b, k, i) => b | (s[k] ? 1 << i : 0), 0);
    const row = STEP.map((k) => (k === 'buttons' ? buttons : Number(s[k] ?? 0)));
    const key = JSON.stringify(row);
    if (key === last) runs[runs.length - 1][0]++;
    else runs.push([1, row]);
    last = key;
  }
  return runs;
}

/**
 * Keeps the cases a test file proves for check program `check` (aicheck, simcheck, worldcheck): call
 * the function it returns with each case's name, the scenario as the program was given it, and what
 * it printed, once the comparison has passed. With RUINA_GOLDEN set they're written when the file is
 * done, in name order, each script's steps once however many cases play it.
 */
export function golden(check: string): (name: string, input: unknown, printed: string) => void {
  const cases = new Map<string, { name: string; input: Record<string, unknown>; hash: string }>();
  if (process.env.RUINA_GOLDEN) {
    afterAll(() => {
      const scripts: string[] = [];
      const list = [...cases.values()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((c) => {
          if (!Array.isArray(c.input.steps)) return c;
          const runs = JSON.stringify(compact(c.input.steps));
          if (!scripts.includes(runs)) scripts.push(runs);
          return { ...c, input: { ...c.input, steps: scripts.indexOf(runs) } };
        });
      mkdirSync(DIR, { recursive: true });
      const parts = [`"check":${JSON.stringify(check)}`, `"step":${JSON.stringify([...STEP, BUTTONS.join(' ')])}`];
      if (scripts.length) parts.push(`"scripts":[\n${scripts.join(',\n')}\n]`);
      parts.push(`"cases":[\n${list.map((c) => JSON.stringify(c)).join(',\n')}\n]`);
      writeFileSync(`${DIR}/${check}.json`, `{${parts.join(',\n')}}\n`);
    });
  }
  return (name, input, printed) => {
    const parsed = (typeof input === 'string' ? JSON.parse(input) : structuredClone(input)) as Record<string, unknown>;
    cases.set(name, { name, input: parsed, hash: fnv1a64(printed.trimEnd()) });
  };
}
