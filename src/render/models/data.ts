import structures from '../../../shared/structures.json' with { type: 'json' };
import farming from '../../../shared/farming.json' with { type: 'json' };
import trade from '../../../shared/trade.json' with { type: 'json' };
import type { Look } from '../../content/looks';

// The slices of shared/*.json the models are built to. Sizes come from here, never from
// constants in the model code, so a footprint changed in the data changes the building too.

export interface StructureData {
  id: string;
  name?: string;
  /** Footprint along X and Z, and overall height. */
  w: number;
  d: number;
  h: number;
  collider: string;
  /** Its body and made model: src/content/looks.ts. */
  look?: Look;
  wall?: number;
  door?: number;
  floor?: number;
  stages?: string[];
  /** Walkable platform top above the origin. */
  deck?: number;
  r?: number;
  colliderD?: number;
  colliderZ?: number;
  interior?: Record<string, { x: number; z: number }>;
}

export type PropData = Omit<StructureData, 'name'>;

export interface CropData {
  id: string;
  name: string;
  kind: 'crop' | 'tree';
  stages: number;
  look?: Look;
}

export interface PackData {
  id: string;
  name: string;
  look?: Look;
}

export const STRUCTURES = structures.structures as unknown as StructureData[];
export const PROPS = structures.props as unknown as PropData[];
export const CROPS = farming.crops as unknown as CropData[];
export const PACKS = trade.packs as unknown as PackData[];

export const structureData = (id: string): StructureData | undefined => STRUCTURES.find((s) => s.id === id);
export const propData = (id: string): PropData | undefined => PROPS.find((s) => s.id === id);
