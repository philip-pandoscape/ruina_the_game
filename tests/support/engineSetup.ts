import { existsSync, readFileSync } from 'node:fs';
import { useEngine } from '../../src/engine/wasm';

// Before each test file (vitest.config.ts setupFiles): the engine's WebAssembly, loaded from the file
// as a page fetches it (src/engine/load.ts), so the rules and the island are there to ask.
const WASM = 'target/wasm32-unknown-unknown/release/ruina_engine_wasm.wasm';
if (!existsSync(WASM)) throw new Error(`${WASM} isn't built: npm run engine`);
useEngine(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {}).exports);

// The engine's own session beside the TypeScript rules (src/engine/shadow.ts): on for the headless
// rules tests (tests/unit/rules), where it fails a test at the first difference; SHADOW=1 turns it
// on for the others too, SHADOW=report writes each test's first difference to scratch/shadow.txt
// and lets the tests go on, and SHADOW=0 turns it off. While it runs the TypeScript's trigonometry
// is the engine's (shadowRules sees to it), so that only the rules can differ.
const testPath = process.env.VITEST ? ((await import('vitest')).expect.getState().testPath ?? '') : '';
const shadow = process.env.SHADOW ?? (testPath.includes('/tests/unit/rules/') ? '1' : '0');
if (shadow !== '0') {
  const { shadowRules } = await import('../../src/engine/shadow');
  if (shadow === 'report') {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const { expect } = await import('vitest');
    mkdirSync('scratch', { recursive: true });
    shadowRules(true, (d) => appendFileSync('scratch/shadow.txt', `${expect.getState().currentTestName ?? '(no test)'}\n${d}\n\n`));
  } else shadowRules(true);
}
