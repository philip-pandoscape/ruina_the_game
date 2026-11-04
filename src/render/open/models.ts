import type * as THREE from 'three';
import type { VehicleDef, MountDef, GliderDef } from '../../content/vehicles';

// The procedural model library (src/render/models), loaded softly: if it is missing or fails to
// load, every caller falls back to a plain stand-in shape instead of taking the game down with it.

export interface Built {
  root: THREE.Object3D;
  animate?(t: number): void;
}

export interface VehicleAnim {
  speed: number;
  steer: number;
  throttle: number;
  sail: number;
  boom: number;
  time: number;
}

export interface ModelKit {
  buildStructure(id: string, opts?: { tint?: number; stage?: number; seed?: number }): Built;
  propGeometry(id: string): THREE.BufferGeometry;
  cropGeometry(id: string, stage: number): THREE.BufferGeometry;
  buildPack(id: string): THREE.Group;
  buildVehicle(def: VehicleDef): { root: THREE.Group; animate(dt: number, s: VehicleAnim): void };
  buildMount(def: MountDef): { root: THREE.Group; animate(dt: number, s: { speed: number; grounded: boolean }): void };
  buildGlider(def: GliderDef): { root: THREE.Group; animate(dt: number, s: { bank: number; pitch: number; speed: number }): void };
  buildAnimal(id: string, stage: number): { root: THREE.Group; animate(dt: number, s: { time: number; hungry: boolean; ready: boolean }): void };
  buildVillager(id: string): { root: THREE.Group; animate(dt: number, s: { time: number; talking: boolean }): void };
}

export type Models = Partial<ModelKit>;

export async function loadModels(): Promise<Models> {
  const found = import.meta.glob('../models/index.ts');
  const load = Object.values(found)[0];
  if (!load) return {};
  try {
    return (await load()) as Models;
  } catch (e) {
    console.warn('models failed to load; using stand-ins', e);
    return {};
  }
}

/** Calls a model builder, or returns null if it is missing or throws. */
export function tryBuild<T>(fn: (() => T) | null | undefined): T | null {
  if (!fn) return null;
  try {
    return fn();
  } catch (e) {
    console.warn('model build failed; using a stand-in', e);
    return null;
  }
}
