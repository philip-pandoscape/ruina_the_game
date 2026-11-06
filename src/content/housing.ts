import data from '../../shared/housing.json' with { type: 'json' };

// What houses are built from and what they give you (shared/housing.json).

export interface StageDef {
  name: string;
  /** Material packs (by pack id) the stage consumes. */
  needs: Record<string, number>;
  labor: number;
  desc: string;
}

export interface BlueprintDef {
  id: string;
  name: string;
  structure: string;
  plot: number;
  taxPerDay: number;
  graceDays: number;
  stages: StageDef[];
  perks: { storageSlots: number; restLaborMultiplier: number };
}

export const BLUEPRINTS = data.blueprints as unknown as BlueprintDef[];

/** The structure an unclaimed house plot is marked out with. */
export const PLOT_MARKER: string | undefined = (data as { plotMarker?: string }).plotMarker;

export function blueprintDef(id: string): BlueprintDef {
  const b = BLUEPRINTS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown blueprint "${id}"`);
  return b;
}
