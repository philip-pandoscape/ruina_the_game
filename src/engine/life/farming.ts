import type { Plant, Scarecrow } from './land';
import { cropDef, FARM } from '../../content/farming';
import { toWorld } from '../world/frames';

// Scarecrow plots and what grows in them, as the page reads them. A scarecrow claims an 8 x 8 m
// patch of open, level ground (up to three); each of its 2 m cells holds one plant, which grows in
// real time - faster in its own climate, faster again when watered or rained on - whether or not
// you are watching. The engine grows them (crates/engine/src/life/farming.rs).

const HALF = (FARM.scarecrowCells * FARM.cell) / 2;

export function stageOf(p: Plant): number {
  if (p.animal) return p.growth >= 1 ? 1 : 0;
  const def = cropDef(p.crop);
  if (p.growth >= 1) return def.stages - 1;
  return Math.min(def.stages - 2, Math.floor(p.growth * (def.stages - 1)));
}

export function cellCentre(sc: Scarecrow, idx: number): { x: number; z: number } {
  const n = FARM.scarecrowCells;
  const col = idx % n;
  const row = Math.floor(idx / n);
  const [ox, oz] = toWorld((col - (n - 1) / 2) * FARM.cell, (row - (n - 1) / 2) * FARM.cell, sc.rot);
  return { x: sc.x + ox, z: sc.z + oz };
}

/** Where the scarecrow itself stands: just outside the plot's front-left corner. */
export function scarecrowPost(sc: { x: number; z: number; rot: number }): { x: number; z: number } {
  const [ox, oz] = toWorld(HALF + 0.6, HALF + 0.6, sc.rot);
  return { x: sc.x + ox, z: sc.z + oz };
}
