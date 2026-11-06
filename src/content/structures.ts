import data from '../../shared/structures.json' with { type: 'json' };
import type { Look } from './looks';

// Buildings and props, as content: footprint, height and how they block you. The zone generator
// builds colliders from these and the models in src/render/models are made to the same sizes.

export interface StructureDef {
  id: string;
  name: string;
  w: number;
  d: number;
  h: number;
  /** 'building': walls, floors, stairs and furniture from its plan (shared/buildings.json). */
  collider: 'box' | 'walls' | 'none' | 'post' | 'building';
  /** For 'box': a collider shallower than the footprint, offset along Z (open-fronted stalls). */
  colliderD?: number;
  colliderZ?: number;
  /** For 'post'. */
  r?: number;
  /** For 'walls'. */
  wall?: number;
  door?: number;
  floor?: number;
  /** A walkable platform top this high above the origin. */
  deck?: number;
  /** false: set on the ground as it lies (a farm plot, a scarecrow); otherwise the ground under it is levelled to a pad. */
  pad?: boolean;
  /** Stands at sea level rather than on the ground (a pier on its piles). */
  seaLevel?: boolean;
  /** How far round it the island keeps trees and rocks off (the zone's scatter.clearOfStructure if not given). */
  clearMargin?: number;
  /** What the ground under it is made of (src/engine/world/terrain.ts SURFACE: tilled soil under a farm plot). */
  surface?: string;
  /** What it is drawn as (src/content/looks.ts): none, a plain block with a roof. */
  look?: Look;
  stages?: string[];
  interior?: Record<string, { x: number; z: number }>;
}

export interface PropDef {
  id: string;
  w: number;
  d: number;
  h: number;
  collider: 'box' | 'post' | 'none';
  r?: number;
  /** What it is drawn as (src/content/looks.ts): none, a crate its size. */
  look?: Look;
}

const STRUCTURES = new Map((data.structures as unknown as StructureDef[]).map((s) => [s.id, s]));
const PROPS = new Map((data.props as unknown as PropDef[]).map((p) => [p.id, p]));

export function structureDef(id: string): StructureDef {
  const s = STRUCTURES.get(id);
  if (!s) throw new Error(`unknown structure "${id}"`);
  return s;
}

export function propDef(id: string): PropDef {
  const p = PROPS.get(id);
  if (!p) throw new Error(`unknown prop "${id}"`);
  return p;
}

export const structureIds = (): string[] => [...STRUCTURES.keys()];
