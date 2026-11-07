import * as THREE from 'three';
import { expect, test } from 'vitest';
import { fract, fromScene, nextOrigin, noiseShift, ORIGIN_REACH, ORIGIN_STEP, repeatShift, setSceneOrigin, toScene, wrapTurn } from '../../src/render/origin';
import { makeRng } from '../../src/util/rng';

// The floating origin's arithmetic (src/render/origin.ts): where the scene's origin stands, and what
// the patterns laid in the world (the ground's textures, the sea's noise and foam) are handed so that,
// drawn from positions relative to it in the graphics card's 32-bit floats, they come out as the
// world's own to well under a texel, however far out; and as badly as they would without it.

/** What the graphics card does with a number: rounds it to 32 bits. */
const f32 = Math.fround;

test('the origin stays at the world origin round Emberholm, and moves in whole steps once the camera is far from it', () => {
  // Anywhere on or round Emberholm (and the fixture world's regions out to 3 km): it never moves.
  for (const [x, z] of [
    [0, 0],
    [768, -768],
    [-3000, 2500],
    [ORIGIN_REACH, -ORIGIN_REACH],
  ])
    expect(nextOrigin(0, 0, x, z)).toEqual([0, 0]);
  // Past it: the lattice point nearest the camera.
  expect(nextOrigin(0, 0, ORIGIN_REACH + 1, 0)).toEqual([ORIGIN_STEP * 2, 0]);
  expect(nextOrigin(0, 0, 102_696, 10)).toEqual([102_400, 0]);
  // And it stays there while the camera is within reach of it, so it doesn't flick back and forth.
  expect(nextOrigin(102_400, 0, 102_400 + 2900, -2900)).toEqual([102_400, 0]);
  expect(nextOrigin(102_400, 0, 98_000, 0)).toEqual([98_304, 0]);
  // Every origin is a lattice point, so the camera is never more than a reach and a step from it.
  const rng = makeRng(7);
  let o: [number, number] = [0, 0];
  for (let i = 0; i < 2000; i++) {
    const cam: [number, number] = [(rng() - 0.5) * 4e5, (rng() - 0.5) * 4e5];
    o = nextOrigin(o[0], o[1], cam[0], cam[1]);
    expect(Math.abs(o[0] % ORIGIN_STEP) + Math.abs(o[1] % ORIGIN_STEP)).toBe(0);
    expect(Math.max(Math.abs(cam[0] - o[0]), Math.abs(cam[1] - o[1]))).toBeLessThanOrEqual(ORIGIN_REACH);
  }
});

test('a texture laid in the world: drawn from the origin plus its shift, it is where the world puts it, far out too', () => {
  const rng = makeRng(11);
  // The ground's repeats per metre (src/render/open/ground.ts) and the grain's (models/detail.ts).
  for (const scale of [1 / 4.5, 1 / 3.5, 1 / 4, 1 / 9, 1 / 3, 1 / 2.6, 0.55])
    for (let i = 0; i < 500; i++) {
      const world = 102_400 + (rng() - 0.5) * 6000;
      const [origin] = nextOrigin(0, 0, world, 0);
      const exact = fract(world * scale);
      // The card: the position relative to the origin, as a float, times the scale, plus the shift.
      const drawn = fract(f32(f32(f32(world - origin) * f32(scale)) + f32(repeatShift(origin, scale))));
      const off = Math.min(Math.abs(drawn - exact), 1 - Math.abs(drawn - exact));
      expect(off).toBeLessThan(2e-4); // a fifth of a texel of a 1024-pixel texture
    }
  // Without it, 102 km out, the world position as a float alone is a texel or more off.
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const world = 102_400 + (rng() - 0.5) * 6000;
    const exact = fract(world / 4.5);
    const drawn = fract(f32(f32(world) * f32(1 / 4.5)));
    worst = Math.max(worst, Math.min(Math.abs(drawn - exact), 1 - Math.abs(drawn - exact)));
  }
  expect(worst).toBeGreaterThan(1 / 1024);
  // At the world's origin the shift is nothing at all: Emberholm is drawn as it always was.
  expect(repeatShift(0, 1 / 4.5)).toBe(0);
});

test("the turned grass sample's shift: the origin turned and shrunk as the shader turns it", () => {
  const rng = makeRng(13);
  const s = 1 / 4.5;
  for (let i = 0; i < 300; i++) {
    const [wx, wz] = [102_400 + (rng() - 0.5) * 6000, -2048 + (rng() - 0.5) * 6000];
    const [ox, oz] = nextOrigin(0, 0, wx, wz);
    // The world's: R (u, v) 0.31 + 0.37 with (u, v) the world in repeats.
    const [u, v] = [wx * s, wz * s];
    const exact = [fract((0.8 * u + 0.6 * v) * 0.31 + 0.37), fract((-0.6 * u + 0.8 * v) * 0.31 + 0.37)];
    // Drawn: R (relative in repeats) 0.31 plus the shift (stage's uGrassShift).
    const [ru, rv] = [(wx - ox) * s, (wz - oz) * s];
    const [ou, ov] = [ox * s, oz * s];
    const shift = [fract((0.8 * ou + 0.6 * ov) * 0.31 + 0.37), fract((-0.6 * ou + 0.8 * ov) * 0.31 + 0.37)];
    const drawn = [fract((0.8 * ru + 0.6 * rv) * 0.31 + shift[0]), fract((-0.6 * ru + 0.8 * rv) * 0.31 + shift[1])];
    for (let k = 0; k < 2; k++) expect(Math.min(Math.abs(drawn[k] - exact[k]), 1 - Math.abs(drawn[k] - exact[k]))).toBeLessThan(1e-6);
  }
});

test("the sea's noise: the same lattice, and the hash's whole part as a phase worked out in 64 bits", () => {
  const rng = makeRng(17);
  for (const f of [0.11, 0.37, 0.16, 0.29])
    for (let i = 0; i < 300; i++) {
      const [wx, wz] = [102_400 + (rng() - 0.5) * 6000, (rng() - 0.5) * 6000];
      const [ox, oz] = nextOrigin(0, 0, wx, wz);
      const n = noiseShift(ox, oz, f);
      // The lattice cell a point is in: relative, plus the shift's fraction, plus the whole part
      // (which goes into the phase) is the world's.
      const whole = [Math.floor(ox * f), Math.floor(oz * f)];
      expect(Math.floor((wx - ox) * f + n.x) + whole[0]).toBe(Math.floor(wx * f));
      expect(Math.floor((wz - oz) * f + n.z) + whole[1]).toBe(Math.floor(wz * f));
      // sin(dot(cell, c) + phase) is sin(dot(cell + whole, c)): the world's hash.
      const cell = [Math.floor((wx - ox) * f + n.x), Math.floor((wz - oz) * f + n.z)];
      const world = Math.sin((cell[0] + whole[0]) * 127.1 + (cell[1] + whole[1]) * 311.7);
      expect(Math.sin(cell[0] * 127.1 + cell[1] * 311.7 + n.phase)).toBeCloseTo(world, 6);
      expect(Math.abs(n.phase)).toBeLessThanOrEqual(Math.PI);
    }
  // At the world's origin: nothing added, the sea as it always was.
  expect(noiseShift(0, 0, 0.11)).toEqual({ x: 0, z: 0, phase: 0 });
  expect(wrapTurn(0)).toBe(0);
});

test('points go between the world and the scene through its origin', () => {
  setSceneOrigin(102_400, -2048);
  const v = toScene(new THREE.Vector3(102_696.25, 5, 10.5));
  expect(v.toArray()).toEqual([296.25, 5, 2058.5]);
  expect(fromScene(v).toArray()).toEqual([102_696.25, 5, 10.5]);
  setSceneOrigin(0, 0);
  expect(toScene(new THREE.Vector3(1, 2, 3)).toArray()).toEqual([1, 2, 3]);
});
