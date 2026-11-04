import data from '../../shared/farming.json' with { type: 'json' };

// Crops, trees, climates and weather (shared/farming.json).

export interface CropDef {
  id: string;
  name: string;
  kind: 'crop' | 'tree';
  climate: string;
  icon: string;
  growSeconds: number;
  stages: number;
  /** Trees that fruit again: seconds from picked back to ripe. */
  regrowSeconds?: number;
  seed: string;
  produce: string | null;
  yield: [number, number];
  seedChance: number;
  harvestLabor: number;
  plantLabor: number;
  chop?: { item: string; yield: [number, number]; labor: number };
  look: string;
}

export const FARM = {
  cell: data.cell,
  scarecrowCells: data.scarecrowCells,
  maxScarecrows: data.maxScarecrows,
  climateMatch: data.climateMatch,
  climateMismatch: data.climateMismatch,
  water: data.water,
  rain: data.rain,
};
export const CLIMATES = data.climates as Record<string, { name: string; icon: string }>;

/** What a resource node gives when worked (shared/farming.json `gathering`). */
export interface GatherDef {
  item: string;
  n: [number, number];
  labor: number;
  verb: string;
  respawn: number;
  kind: string;
  rare?: { item: string; chance: number };
}
export const GATHERING = data.gathering as unknown as Record<string, GatherDef>;
export const CROPS = data.crops as unknown as CropDef[];
const BY_ID = new Map(CROPS.map((c) => [c.id, c]));

export function cropDef(id: string): CropDef {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown crop "${id}"`);
  return c;
}

/** Growth-rate multiplier for a crop in a zone's climate. */
export const climateFactor = (crop: CropDef, climate: string): number => (crop.climate === climate ? FARM.climateMatch : FARM.climateMismatch);

/** A farm animal (shared/farming.json `animals`). */
export interface AnimalDef {
  id: string;
  name: string;
  icon: string;
  young: string;
  item: string;
  growSeconds: number;
  feed: string;
  feedN: number;
  /** How long one feeding lasts. */
  feedSeconds: number;
  produce: string;
  yield: [number, number];
  produceSeconds: number;
  collectLabor: number;
  verb: string;
}

export const ANIMALS = (data.animals ?? []) as unknown as AnimalDef[];

export function animalDef(id: string): AnimalDef {
  const a = ANIMALS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown animal "${id}"`);
  return a;
}
