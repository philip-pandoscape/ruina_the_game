import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The browser's engine is the server's: the same Rust (crates/engine), compiled to WebAssembly
// (crates/engine-wasm, npm run engine). Here the WebAssembly answers the same ground queries as the
// native build (crates/tools engineprobe), and the two fingerprints must match to the bit.

const WASM = 'target/wasm32-unknown-unknown/release/ruina_engine_wasm.wasm';
const PROBE = `target/release/engineprobe${process.platform === 'win32' ? '.exe' : ''}`;
const SEEDS = [1, 2, 3];
const N = 20_000;

test('the WebAssembly engine answers exactly as the native one', (ctx) => {
  ctx.skip(!existsSync(WASM) || !existsSync(PROBE), 'build them first: npm run engine && cargo build --release --bin engineprobe');
  const engine = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), {}).exports as { probe(n: number, seed: number): bigint };
  const native = execFileSync(PROBE, [String(N), ...SEEDS.map(String)], { encoding: 'utf8' })
    .trim()
    .split(/\s+/);
  expect(SEEDS.map((s) => BigInt.asUintN(64, engine.probe(N, s)).toString())).toEqual(native);
});
