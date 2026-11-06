import { existsSync, readFileSync } from 'node:fs';
import { useEngine } from '../../src/engine/wasm';

// Before each test file (vitest.config.ts setupFiles): the engine's WebAssembly, loaded from the file
// as a page fetches it (src/engine/load.ts), so the rules and the island are there to ask.
const WASM = 'target/wasm32-unknown-unknown/release/ruina_engine_wasm.wasm';
if (!existsSync(WASM)) throw new Error(`${WASM} isn't built: npm run engine`);
useEngine(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {}).exports);
