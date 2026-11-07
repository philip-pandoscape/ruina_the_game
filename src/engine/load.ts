// The engine's file, for a page to load at its start (src/engine/wasm.ts): built by `npm run engine`
// (crates/engine-wasm), which `npm run dev` and `npm run build` run first. Every page that reaches
// the world (the game, the bible, the content library) awaits this before anything else.
import url from '../../target/wasm32-unknown-unknown/release/ruina_engine_wasm.wasm?url';
import { loadEngine } from './wasm';

export const startEngine = (): Promise<void> => loadEngine(url);

/** Content for the engine to read in place of what's built into it, before it reads anything (a fixture world of the tests'). */
export { useContent } from './wasm';
